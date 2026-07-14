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

每个 task 都绑定：

```text
task id
pane id
pane incarnation id
owner MCP/RPC session
startedAt / finishedAt
running / numeric exit code / unknown
```

任务运行期间，pane 被启动任务的 MCP/RPC session 独占：

- `tmux_input` 和 `tmux_read` 必须携带 task id；
- 只有 task owner session 可以输入或消费输出；
- 其他 session 调用时返回 `tmux.taskLocked`；
- `tmux_inspect` 始终可以观察终端画面；
- task 退出后，输出被冻结到 task，pane 立即释放并可运行下一个 task。

session 关闭不会终止正在运行的 task。task 会标记 `ownerConnected = false`，pane 继续锁定，直到任务自然退出。worker 重启时仍在运行的 task 会作为 orphaned task 被接管，但不会允许新 session 直接输入。

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
2. 否则选择创建时间最早的空闲 pane；
3. 没有空闲 pane 且未达到容量时，创建 `auto-1`、`auto-2` 等 pane；
4. 达到容量时返回 `tmux.capacityReached`。

`wait` 支持：

```text
block     等待 task 退出或 timeMs 到期
nonblock  shell 确认 task 已启动后返回
```

等待期间不会持有 pane 操作锁，因此同一 owner session 可以并发调用 `tmux_input` 发送 `^C`，或调用 `tmux_read` 获取输出。

返回值包含 task id。后续交互不得只依赖 pane：

```json
{
    "task": {
        "id": "task-...",
        "paneId": "pane-...",
        "status": "running",
        "ownerConnected": true
    }
}
```

## 取消等待

取消 `tmux_run` 只终止当前 RPC 等待，不向终端发送信号，也不结束已经启动的 task。返回取消后，task 仍由原 session 持有，可以继续使用 `tmux_read`、`tmux_input` 或后续 `tmux_inspect` 观察。

取消 `tmux_read` 会停止等待且不消费本次尚未返回的 task 输出。需要真正中断前台程序时，调用 `tmux_input` 向对应 task 发送 `^C`。

## 交互输入

```json
{
    "task": "task-...",
    "input": "^C",
    "timeMs": 1000,
    "line": 40
}
```

`input` 使用 caret notation：

```text
^M  Enter / CR
^C  interrupt
^D  EOF
^I  Tab
```

`^B` / Ctrl-B 被禁止，避免通过 tmux prefix 绕过受管接口。

相同 `sessionId + requestId` 的副作用调用会返回首次执行结果，不会重复发送命令、按键、创建或关闭 pane。相同 request id 携带不同参数时返回 `tmux.requestIdConflict`。

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

`tmux_inspect` 不消费 task 输出，也不受 task owner 锁限制。可以通过 `panes = "all"` 检查所有受管 pane。

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

每个 pane 包含：

```text
id                       稳定逻辑 ID
name                     instance 内唯一名称
tmuxPaneId               底层 tmux 坐标，仅用于诊断
locked                   是否被运行中 task 或外部前台命令占用
ownedByCurrentSession     当前 session 是否为 task owner
task                     当前运行中的 task
```

## 创建与关闭 pane

显式创建：

```json
{
    "name": "server",
    "relativeTo": "main",
    "position": "right",
    "sizePercent": 40,
    "cwd": "./"
}
```

名称允许字母、数字、点、下划线和连字符。`cwd` 遵循 worker 路径规则和 instance security policy。

运行中 task 的 pane：

- owner session 使用 `force = true` 可以终止；
- 其他 session 即使设置 `force = true` 也会得到 `tmux.taskLocked`；
- 最后一个受管 pane不能关闭。

## 并发与容量

结构操作使用全局结构锁，命令和输入只在短临界区内使用 pane 锁。等待输出或退出时不会持锁。

worker 最多同时执行 8 个工具调用，其中普通工具最多占 6 个槽位，剩余容量保留给：

```text
tmux_input
tmux_inspect
tmux_list
```

control scheduler 也允许一项 urgent tmux 调用越过普通 instance/session 并发上限，并优先调度已排队的 urgent 调用。

## 生命周期与存储

worker 正常停止时不会销毁 tmux server 和 pane。重新启动同一个 instance 后，worker 通过 tmux metadata 接管原有 pane，并返回新的 `observationEpoch` 和 `observationReset = true`。

运行时 socket：

```text
$XDG_RUNTIME_DIR/devshell-worker/<instance>/tmux.sock
```

持久元数据：

```text
~/.devshell/<instance>/tmux/
```

目标环境必须安装 `tmux`。如果 `tmux -V` 不可用，worker 不会注册 tmux 工具。
