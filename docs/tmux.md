# tmux 工具

`devshell-worker` 原生提供一组 tmux 工具，用于长时间运行的 PTY task 和持久交互终端。

```text
tmux_run
tmux_input
tmux_read
tmux_inspect
tmux_list
tmux_create
tmux_close
```

核心模型只有两类 terminal resource：

```text
managed task
    tmux_run 创建
    独占一个全新的临时 pane
    task 结束后 pane 销毁
    task metadata 与 transcript 继续保留

persistent interaction
    main 或 tmux_create 创建的 pane
    使用用户真实交互 shell
    pane 独立于其中运行的程序而持续存在
    只有显式 tmux_close 才销毁
```

一句话概括：task owns its terminal；interaction owns the terminal itself。

## Pane、task 与程序

pane 是 PTY resource。task 是一次由 `tmux_run` 明确创建并由 worker 跟踪的 managed execution scope。task 内部实际运行的 shell、编译器、REPL、编辑器或子进程只是 terminal-side program，不会自动成为新的 task。

只有 `tmux_run` 创建 task：

```text
tmux_run("bash")
    -> task-A

tmux_input(task-A, "vim foo^M")
    -> vim 是 task-A 内部程序
    -> 不创建 task-B
```

`tmux_input` 不解释输入含义。相同按键既可以是 shell command、REPL 输入、TUI shortcut，也可以只是普通字符。

每个 running task 绑定自己的 pane id 和 pane incarnation id。旧 task control 不会因为 pane 身份变化而落到错误终端。

Task 不绑定创建它的 `ctxId`。MCP/RPC transport session 关闭、上下文刷新或后续获得新的有效 `ctxId`，都不会改变 instance 内 running task 的生命周期或控制权。

## `main` 与 persistent pane

每个受管 session 始终有一个名为 `main` 的 persistent interactive pane。`main` 是 agent 的默认交互终端，不能关闭。

`tmux_create` 创建额外的 persistent interactive pane：

```json
{
    "name": "debug",
    "cwd": "./backend"
}
```

`main` 和 `tmux_create` pane 都启动用户配置的 `$SHELL`，并读取用户正常的交互 shell 配置。prompt、fastfetch、alias、shell function、virtualenv hook 等都属于 persistent interaction 的真实状态。

程序从 persistent pane 中退出后，pane 本身仍存在：

```text
shell -> python -> shell -> vim -> shell
```

worker 不尝试把其中每条命令识别为 managed task。

## `tmux_run`

`tmux_run` 用于长时间运行、需要 PTY，或后续可能需要 terminal input 的 task。

```json
{
    "command": "set -e\ncargo build\ncargo test",
    "cwd": "./",
    "wait": "nonblock"
}
```

每次调用都会：

```text
创建 fresh pane
-> 在 pane 中直接启动 clean Bash runner
-> 建立 task transcript capture
-> 启动用户 shell program
-> task 独占该 pane
-> task 结束后冻结状态并销毁 pane
```

不存在 idle pane reuse、`auto-*` pane pool 或 task pane GC cache。

### Command language

`command` 是 Bash shell program，不是向某个已有 prompt paste 的字符序列，因此天然支持多行、条件、循环和 heredoc。

Unix task runner 使用 clean Bash：

```text
/bin/bash --noprofile --norc
```

它继承 worker 的基础 environment，但不会加载用户 `.bashrc`、`.zshrc`、Fish config、prompt 或其他 interactive shell state。

这与 persistent pane 故意不同：

```text
tmux_run     clean Bash execution environment
tmux_create  user's interactive shell environment
main         user's interactive shell environment
```

### `cwd`

`cwd` 使用与其他 worker path 一致的语义：

```text
./foo   workspace-relative
/foo    absolute path
```

省略时默认当前 workspace。worker 在真正放行 task program 前验证新 pane 的实际 cwd 仍对应已解析目录，避免路径在创建过程中被替换。

### Wait

`wait`：

```text
block     等待 task 退出或 timeMs 到期
nonblock  task 成功启动后立即返回（默认）
```

`timeMs` 只限制这次 RPC 等待，不停止 task。block wait 超时会返回 `tmux.blockTimeout` warning，task 继续运行。

running task 的返回值包含 task 和它当前独占的 pane：

```json
{
    "task": {
        "id": "task-...",
        "status": "running"
    },
    "pane": {
        "id": "pane-...",
        "name": "task-..."
    }
}
```

task 结束后 pane 被销毁，因此完成态返回值不再附带 stale pane ref，也不能再 `tmux_inspect` 该 pane；task id 和 transcript 仍可继续用于 `tmux_read`。

## `tmux_input`

`tmux_input` 的唯一语义是发送 raw terminal input。调用必须指定且只指定一个 target：

```text
task=<task id>   running managed task
pane=<pane>      persistent interactive pane
```

### Managed task input

```json
{
    "task": "task-...",
    "input": "^C",
    "timeMs": 1000,
    "line": 40
}
```

managed task 必须通过 task id 控制。即使调用方知道其临时 pane id，也不能通过 `pane=` 绕过 task identity；这类调用返回 `tmux.taskTargetRequired`。

对 task target，`timeMs` 可以等待新的 transcript output，`line` 控制顺便消费多少 transcript 行。

### Persistent pane input

```json
{
    "pane": "main",
    "input": "cd /tmp^M"
}
```

persistent pane 通过 pane id/name 控制。输入返回后不会建立 command/task 边界。需要观察结果时使用 `tmux_inspect`。

persistent pane target 不使用 `line`，也不使用非零 `timeMs`。

### Caret notation

输入支持 caret notation：

```text
^M  Enter / CR
^B  Ctrl-B
^C  interrupt
^D  EOF
^I  Tab
```

相同 `contextId + requestId` 的副作用请求使用 replay protection，不会因为重试重复发送按键。

## `tmux_read`: task transcript

`tmux_read` 只接受 task id，并消费该 managed task 的 durable transcript：

```json
{
    "task": "task-...",
    "line": 80,
    "timeMs": 1000
}
```

Transcript 从 task 自己的 fresh pane 通过 tmux `pipe-pane` 旁路采集。用户 command 不会被包进 `tee`，因此不会改变 pipeline、exit status 或 TTY 判断。

读取语义：

```text
line > 0  返回最早的 N 行未读 transcript
line = 0  丢弃当前未读 transcript
line < 0  返回最后 N 行，并丢弃更早的未读内容
```

运行中的 task 若最后一行尚未形成完整换行，`tmux_read` 不会提前消费它；task 结束后会允许返回最终 partial line。

Transcript 展示层会处理常见 terminal 控制：ANSI control sequence 不作为正文返回，bare CR 表示重绘当前 logical line，backspace 会更新当前 line。完整 terminal screen semantics 不属于 transcript；TUI/curses 应使用 `tmux_inspect`。

已完成 task 最多保留 64 个，默认保留 30 分钟。完成态 metadata 与 transcript 一起持久化，因此 worker restart 不会提前打断这段 retention；超过 retention 后返回 `tmux.taskExpired`。Task pane 的销毁不影响这段 retention。

`tmux_read` 的已读 offset 也会持久化。worker restart / running-task adoption 后继续读取时，不会把 restart 前已经消费或丢弃的 transcript 当成新输出重复返回。

## `tmux_inspect`: terminal history

`tmux_inspect` 观察 pane，而不是 task：

```json
{
    "pane": "main",
    "start": -80,
    "end": 0
}
```

可以 inspect：

```text
main
显式 tmux_create pane
仍在运行的 task pane
```

running task 的 pane ref 来自 `tmux_run` 或 `tmux_list`。task 结束以后临时 pane 已不存在，此时应使用 `tmux_read` 查看 retained transcript。

`start` / `end` 使用相对 terminal history 坐标，`0` 表示当前底部，负数表示更早位置。单次最多请求 200 行。受管 tmux session 的 history limit 为 10000 行，因此 persistent interaction 可以像普通终端一样通过不同 offset 向上查看较长历史。

`panes = "all"` 可以一次检查所有当前 pane。

`tmux_inspect` 不消费任何 task transcript。

## `tmux_list`

`tmux_list` 返回当前仍存在的 pane：

```text
main
persistent tmux_create panes
running task panes
```

已完成 task 的 pane 不会继续出现在列表中。

状态保持紧凑字符串：

```text
idle
running
terminated
unknown
0
1
130
```

数字字符串是 task 或最近前台 command 的退出状态。`terminated` 表示 managed task 被显式 `tmux_close(force=true)` 终止；`unknown` 保留给 pane 身份丢失等无法确定最终状态的情况。

`tmux_list` 只返回 compact summary；cwd、command、terminal size 和 history 由 `tmux_inspect` 提供。

## `tmux_close`

`tmux_close` 必须指定且只指定一个 target。

### Close task

```json
{
    "task": "task-...",
    "force": true
}
```

running task 不设置 `force` 时返回 `tmux.taskBusy`。`force=true` 终止 task 并销毁它拥有的临时 pane。Task transcript 仍按 completed-task retention 保留。

### Close persistent pane

```json
{
    "pane": "debug",
    "force": true
}
```

persistent pane 有 running foreground process 时需要 `force=true`。`main` 永远不能关闭。

managed task pane 不能通过 `pane=` close；必须使用 task id。

## 取消语义

取消 `tmux_run` 只停止当前 RPC wait，不向 terminal 发送信号，也不结束已经启动的 task。

取消 `tmux_read` 停止等待，并且不会消费这次尚未返回的 transcript。

需要正常终止 terminal-side program 时通常发送：

```text
tmux_input(task=..., input="^C")
```

需要无条件销毁 managed execution resource 时使用：

```text
tmux_close(task=..., force=true)
```

## 并发与 replay

每个 running task 独占自己的 pane。对同一个 terminal endpoint 的 input 使用 pane-level operation lock，因此不同 context 的并发 `tmux_input` 不会把单次输入互相穿插。

等待 task 输出或 task 退出时不会长期持有 pane operation lock，其他有效上下文仍可 inspect、read 或 input。

`tmux_run`、`tmux_input`、`tmux_create`、`tmux_close` 保持 request replay protection：相同 request identity 和参数返回首次执行结果；同一 request identity 携带不同参数返回 `tmux.requestIdConflict`。

## 容量

受管 session 的 pane 数量有固定上限。Persistent pane 永不因容量压力自动回收；running task pane 也不会被其他调用抢占。

容量已满时：

```text
tmux_create -> tmux.capacityReached
tmux_run    -> tmux.capacityReached
```

task 正常结束后，其临时 pane 立即释放容量。

## Worker restart

worker 正常停止不会销毁 tmux server。重新启动同一 workspace 后：

- persistent pane 保持原身份和 terminal state；
- metadata 完整且仍在 running 的 task pane会被自动 adopt；
- adopted task 继续使用原 task id、transcript 与未读 cursor；
- 已完成 task 在 retention 内同样继续可读，且不会重放已经消费的 transcript；
- 首次观察会通过 warning 提示 observation reset / task adoption。

不需要额外 reclaim 工具。

## 存储

每个 workspace 的 tmux runtime 使用独立 storage/socket scope。持久 metadata、task script 和 transcript 位于 instance 的 tmux state 目录中。

目标环境必须安装 `tmux`。如果 `tmux -V` 不可用，worker 不注册 tmux 工具。
