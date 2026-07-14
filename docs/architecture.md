# 当前架构

这份文档描述当前代码中的运行模型，不记录已经被替换的早期方案。

## 总体结构

```text
CLI / TUI
    │ control RPC
    ▼
TypeScript control daemon
    ├── 配置、实例注册、状态与事件
    ├── MCP / OAuth HTTP host
    ├── Artifact 分享与跨实例传输
    └── Todo、审批和审计入口
             │
             ▼
      core WorkerInstance
             │ provider transport
             ▼
Rust devshell-worker daemon
    ├── local
    ├── SSH
    ├── Docker / Podman
    └── reverse（WSS，SSE + HTTPS POST 回退）
```

CLI 和 TUI 都是 control client。它们不直接读取实例配置、不自行启动 worker，也不持有真实运行状态。

## 实例模型

每个 instance 绑定一个 provider 和一个 workspace。当前 provider 为：

```text
local
ssh
docker
podman
reverse
```

实例配置独立保存在：

```text
~/.devshell/control/instances/<instance>.toml
```

实例名必须包含连字符，例如 `demo-local`。实例配置版本为 `2`。

## Worker 模型

worker 是自行维护生命周期的 daemon。control 通过 provider transport 完成安装、启动、状态查询、日志读取和 RPC 连接。

worker RPC 使用四字节大端长度前缀 JSON frame。握手和工具发现分离为：

```text
worker.handshake
tools.list
```

工具 schema 由目标 worker 提供，因此不同平台或版本可以暴露不同能力。

## MCP 模型

每个启用 MCP 的实例默认对应：

```text
/<instance>/mcp
```

工具策略由两个正交维度控制：

```toml
[mcp.tools]
groups = ["file", "bash", "artifact", "tmux", "todo"]
capabilities = ["read", "write", "execute"]
```

默认不暴露实例管理。只有同时启用 `instance` group 和 `manage` capability，endpoint 才会出现实例管理工具，并允许其他工具通过可选 `instance` 参数路由到另一受管实例。

## 工具职责

worker 原生工具：

```text
bash_run
artifact_read
file_read
file_edit
file_find
file_search
file_info
tmux_send
tmux_capture
tmux_inspect
tmux_list
tmux_create
tmux_close
```

control 合并到 MCP catalog 的工具：

```text
artifact_share
artifact_transfer
todo_read
todo_write
instance_list
instance_status
instance_create
instance_start
instance_stop
```

后五个实例工具只有在 `instance + manage` 策略下出现。

## 审批与调度

审批 gate 位于 core 工具调用链上，CLI、TUI 和 MCP 都经过同一套策略。策略支持：

```text
disabled
allow
ask
deny
```

工具调度器支持全局与按 session 的并发和队列限制。它不是早期设计中的“每实例固定单并发且无队列”模型。

## 反向连接

reverse worker 主动连接 control：

```text
WSS
  └── 失败后回退到 SSE 下行 + HTTPS POST 上行
```

两种 transport 都承载同一套 worker RPC frame。generation、请求 ID 重放和已完成结果缓存用于断线恢复与防止相同请求重复执行。

## 持久化与运行目录

主要持久化目录：

```text
~/.devshell/control/
~/.devshell/<instance>/
~/.devshell/workers/
```

control IPC endpoint：

```text
Linux/macOS    $XDG_RUNTIME_DIR/portable-devshell/control.sock
Windows        \\.\pipe\portable-devshell-control-<user>
```

当 `XDG_RUNTIME_DIR` 不存在时，Unix 使用当前用户专属的临时目录，因此 macOS 不需要额外设置该变量。Windows control 和 worker 使用 Named Pipe，但承载的仍是同一套四字节长度前缀 JSON RPC frame。