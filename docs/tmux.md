# tmux 工具

`devshell-worker` 在目标环境中原生提供一组 tmux 工具，用于持续运行任务、交互式输入和多 pane 并行工作。

## 工具列表

```text
tmux_send
tmux_capture
tmux_inspect
tmux_list
tmux_create
tmux_close
```

一个 portable-devshell instance 对应一个独立的 tmux server 和一个固定的受管 session。工具不接受 session 参数；instance endpoint 已经完成隔离。

## 输入格式

`tmux_send` 的 `input` 使用通用 caret notation 表示终端控制字符：

```text
^M  Enter / CR，用于提交命令
^C  interrupt
^D  EOF
^I  Tab
```

例如：

```json
{
    "pane": "main",
    "input": "cargo test^M",
    "wait": "block",
    "timeMs": 30000,
    "line": 80
}
```

`^B` / Ctrl-B 被禁止，避免通过 tmux prefix 绕过受管 pane 接口。

## wait 模式

- `block`: 从空闲 shell 启动命令，等待命令完成或等待超时。
- `nonblock`: 启动长时间运行的前台任务，出现输出、任务结束或等待超时时返回。
- `interactive`: 向此前通过 `nonblock` 启动的运行中任务继续发送输入。

`timeMs` 只限制本次工具调用的等待时间，不会终止 pane 中的进程。

## pane 身份

每个受管 pane 都有：

- `id`: 稳定逻辑 ID；
- `name`: instance 内不可重复的固定名称；
- `tmuxPaneId`: tmux 的 `%N` 坐标，仅用于诊断。

公开选择器先匹配稳定 ID，再匹配名称。不会接受 `tmuxPaneId` 作为公共选择器。

初始 pane 名为 `main`。创建额外 pane：

```json
{
    "name": "server",
    "relativeTo": "main",
    "position": "right",
    "sizePercent": 40,
    "cwd": "./"
}
```

`cwd` 遵循 worker 的路径规则：`./` 表示 workspace 路径，`/` 表示绝对路径，并继续受 instance security policy 约束。

## 输出与检查

`tmux_capture` 消费当前任务的未读输出；后续调用不会重复返回已经消费的内容。

`tmux_inspect` 读取终端历史但不移动未读游标，可读取单个 pane 或 `panes = "all"`。

`tmux_list` 返回 pane 的稳定身份、状态、cwd、前台命令和容量。状态为：

```text
idle
running
<numeric exit code>
unknown
```

## 生命周期

worker 正常停止时不会销毁 tmux server 和 pane。重新启动同一个 instance 后，worker 会通过 tmux metadata 重新接管原有 pane，并在结果中返回新的 `observationEpoch` 和 `observationReset = true`。

运行时 socket：

```text
$XDG_RUNTIME_DIR/devshell-worker/<instance>/tmux.sock
```

持久元数据：

```text
~/.devshell/<instance>/tmux/
```

目标环境必须安装 `tmux`。如果 `tmux -V` 不可用，worker 不会把 tmux 工具注册到 `tools.list`。
