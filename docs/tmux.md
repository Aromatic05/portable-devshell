# tmux 工具

`devshell-worker` 在目标环境中原生提供一组 tmux 工具，用于持续运行任务、交互式输入、多 pane 并行和终端画面检查。

## 工具列表

```text
tmux_run
tmux_input
tmux_read
tmux_inspect
tmux_list
tmux_create
tmux_close
```

一个 portable-devshell instance 对应一个独立 tmux server 和一个固定受管 session。tmux runtime 按需启动，并始终包含一个名为 `main` 的 pane。受管交互 shell 支持 Bash、Zsh 和 Fish，并在读取用户原有 shell 配置后注入 task 状态 hook。

## Pane 与 task

pane 是持久终端，task 是一次由 `tmux_run` 启动的前台命令。

每个 task 在 worker 内部绑定 pane id 和 pane incarnation id；公开 task 结果只返回：

```text
id
status: running / numeric exit code / unknown
```

task 不绑定创建它的 `ctxId`：

- `tmux_input` 和 `tmux_read` 必须携带 task id；
- 任意已通过 `environ_info` 获得有效 `ctxId` 的当前上下文，都可以继续读取或控制该 instance 内的 managed task；
- `ctxId` 仍用于上下文新鲜度检查、审计、重放保护、取消和调度，但不作为 tmux 资源所有权；
- `taskId` 与 `paneIncarnationId` 防止旧请求落到已经变化的任务或 pane；
- 运行中的 pane 仍受 `tmux.paneBusy` 保护，不能被新的 `tmux_run` 或非强制 `tmux_close` 覆盖；
- task 退出后，输出被冻结到 task，pane 立即释放并可运行下一个 task。

MCP/RPC transport session 关闭、模型上下文刷新或 `ctxId` 变化，都不会让长期运行的 tmux task 失去控制。worker 重启时会自动接管 metadata 完整的 managed task，不需要额外的 reclaim 指令。

## 运行命令

指定 pane：

```json
{
    "pane": "server",
    "command": "cargo test",
    "wait": "block",
    "timeMs": 30000,
    "line": 80
}
```

不指定 pane 时，worker 在同一个结构临界区内：

1. 优先选择空闲的 `main`；
2. 否则选择创建时间最早的空闲 `auto-*` pane；
3. 没有空闲 pane 且未达到容量时，创建 `auto-1`、`auto-2` 等 pane；
4. 达到容量且没有可复用 pane 时返回 `tmux.capacityReached`。

通过 `tmux_create` 显式命名的 pane 不参与自动复用，只有调用方明确指定名称时才会运行任务。worker 通过持久 metadata 区分自动 pane 与显式 pane，因此显式名称不会因为文本形似 `auto-*` 而被回收。

`wait` 支持：

```text
block     等待 task 退出或 timeMs 到期
nonblock  shell 确认 task 已启动后返回
```

等待期间不会持有 pane 操作锁，因此其他有效上下文也可以并发调用 `tmux_input` 发送 `^C`，或调用 `tmux_read` 获取输出。

返回值包含 task id。后续交互不得只依赖 pane：

```json
{
    "task": {
        "id": "task-...",
        "status": "running"
    }
}
```

## 取消等待

取消 `tmux_run` 只终止当前 RPC 等待，不向终端发送信号，也不结束已经启动的 task。返回取消后，task 仍保持运行，任意有效上下文都可以继续使用 `tmux_read`、`tmux_input` 或后续 `tmux_inspect` 观察。

取消 `tmux_read` 会停止等待且不消费本次尚未返回的 task 输出。需要真正中断前台程序时，调用 `tmux_input` 向对应 task 发送 `^C`。

## 交互输入

```json
{
    "task": "task-...",
    "input": "^C",
    "timeMs": 0,
    "line": 40
}
```

`timeMs` 默认是 `0`，按键发送成功后立即返回。只有希望顺便等待新行式输出时才设置正数；curses 或全屏程序应在发送后调用 `tmux_inspect` 查看重绘后的画面。

`input` 使用 caret notation：

```text
^M  Enter / CR
^B  Ctrl-B
^C  interrupt
^D  EOF
^I  Tab
```

相同 `contextId + requestId` 的副作用调用会返回首次执行结果，不会重复发送命令、按键、创建或关闭 pane。相同 request id 携带不同参数时返回 `tmux.requestIdConflict`。

## 读取 task 输出

```json
{
    "task": "task-...",
    "line": 80,
    "timeMs": 1000
}
```

`tmux_read` 使用 task 级滑动窗口和终端历史 diff：

```text
line > 0  返回最早的 N 行未读输出
line = 0  丢弃全部未读输出
line < 0  只返回最后 N 行，并丢弃更早输出
```

每个 task 最多保留 400 行，instance 最多保留 64 个已完成 task，默认保留 30 分钟。超出窗口会返回 `tmux.outputDropped`，过期 task 返回 `tmux.taskExpired`。

这套输出模型面向普通行式命令。进度条覆盖、curses、alternate screen 和其他终端重绘不进行语义 diff，应使用 `tmux_inspect` 查看真实终端画面。

## 检查终端画面

```json
{
    "pane": "server",
    "start": -80,
    "end": 0
}
```

`start` / `end` 使用 tmux 相对历史坐标，`0` 表示当前底部，负数表示更早位置。返回内容仍按从早到晚排列。

`tmux_inspect` 不消费 task 输出。可以通过 `panes = "all"` 检查所有受管 pane。

## Pane 状态

`tmux_list` 返回 pane 身份、cwd、前台命令、当前 task 和容量。状态保持紧凑字符串：

```text
idle
running
unknown
0
1
130
```

数字字符串就是 task 或最近前台命令的退出码。

`tmux_list` 返回紧凑 pane summary：

```text
id                       稳定逻辑 ID
name                     instance 内唯一名称
status                   idle / running / unknown / numeric exit code
task                     当前运行中的 task，可选
```

`tmux_inspect` 才返回 detail；`cwd`、`command`、`size`、`locked`、`task` 和 `lines` 均仅在有值时出现。底层 tmux pane/window ID 不属于公开结果。

## 创建与关闭 pane

每个受管 pane 都位于独立的 tmux window 中。window 默认只包含这一个 pane，因此任务始终获得完整终端尺寸，不会因为其他并发任务而被继续切割。

显式创建：

```json
{
    "name": "server",
    "cwd": "./"
}
```

名称允许字母、数字、点、下划线和连字符。`cwd` 遵循 worker 路径规则和 instance security policy。

运行中 task 的 pane：

- 不设置 `force` 时返回 `tmux.paneBusy`；
- 任意有效上下文使用 `force = true` 都可以终止该 task 并关闭 pane；
- 最后一个受管 pane 不能关闭。

## 并发与容量

结构操作使用全局结构锁，命令和输入只在短临界区内使用 pane 锁。等待输出或退出时不会持锁。

worker 最多同时执行 8 个工具调用，其中普通工具最多占 6 个槽位，剩余容量保留给：

```text
tmux_input
tmux_inspect
tmux_list
```

control scheduler 也允许一项 urgent tmux 调用越过普通 instance/context 并发上限，并优先调度已排队的 urgent 调用。

## 自动回收

worker 只自动回收由 `tmux_run` 创建且在 metadata 中标记为 automatic 的 pane。`main` 和通过 `tmux_create` 显式创建的 pane 永不参与自动回收。

自动 pane 必须同时满足：

- 没有运行中的 task；
- shell 已处于 idle 或记录了数字退出码；
- 没有尚未消费的 task 输出。

回收有两个触发点：

- 后台每 5 分钟扫描一次，连续空闲 30 分钟后回收；
- `tmux_create` 遇到容量已满时，优先回收最久未使用的安全 auto pane，再决定是否返回 `tmux.capacityReached`。

`tmux_read`、`tmux_input`、`tmux_inspect` 和 task 输出返回都会刷新 pane 的最近使用时间；`tmux_list` 不刷新，因此状态轮询不会阻止 GC。成功回收会通过 `tmux.paneCollected` warning 报告，后台扫描失败则通过 `tmux.gcFailed` 报告。

## 生命周期与存储

worker 正常停止时不会销毁 tmux server 和 pane。重新启动同一个 instance 后，worker 通过 tmux metadata 自动接管原有 pane 和仍在运行的 task；首次后续 tmux 结果会携带一次性的 `tmux.observationReset` warning，提示历史输出可能不完整。

运行时 socket：

```text
$XDG_RUNTIME_DIR/devshell-worker/<instance>/tmux.sock
```

持久元数据：

```text
~/.devshell/<instance>/tmux/
```

目标环境必须安装 `tmux`。如果 `tmux -V` 不可用，worker 不会注册 tmux 工具。
