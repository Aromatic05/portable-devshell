# Windows 支持

portable-devshell 在 Windows x64 和 Windows ARM64 上提供完整 client，以及基础能力 worker。

## Client 能力

Windows client 包含：

```text
control daemon
CLI
TUI
MCP HTTP host
OAuth
local / ssh / reverse provider
```

control 与 CLI/TUI 通过当前用户专属的 Windows Named Pipe 通信：

```text
\\.\pipe\portable-devshell-control-<user>
```

Windows 首版不把 Docker Desktop、Windows container 或 Podman Desktop 作为承诺支持的 provider。已有配置仍可被解析，但交互式创建只提供 `local`、`ssh` 和 `reverse`。

## Worker 能力

Windows worker 使用普通 detached 用户进程，不安装 Windows Service，也不要求管理员权限。

基础工具包括：

```text
bash_run
file 工具组
artifact 工具组
reverse connection
```

Windows worker 不注册 `tmux` 工具组，也不提供本地 Attach Shell。Windows client 管理 SSH Linux/macOS instance 时，仍可使用目标 worker 提供的 tmux 和 shell attach。

## PowerShell backend

工具名继续保持 `bash_run`，但 Windows worker 实际执行 PowerShell：

1. 优先探测 `pwsh.exe`；
2. 不存在时使用 `powershell.exe`；
3. `worker.handshake` 报告实际 executable、kind 和 version；
4. `tools.list` 中的 `bash_run` description 只在 Windows worker 上追加 PowerShell 说明。

例如：

```text
Run a command using Windows PowerShell 5.1 on Windows.
The command must use PowerShell syntax, not POSIX shell syntax.
```

portable-devshell 不尝试把 PowerShell 5.1 和 PowerShell 7 的语法差异自动转换为统一方言。

## Worker IPC

每个 Windows worker instance 使用独立 Named Pipe：

```text
\\.\pipe\devshell-worker-<user>-<instance>
```

wire protocol 与 Unix 完全相同，仍然是四字节大端长度前缀加 JSON payload。Named Pipe 只是 transport 替换，不引入第二套 RPC 协议。

## 发布 target

```text
windows-x64      x86_64-pc-windows-msvc
windows-arm64    aarch64-pc-windows-msvc
```

Windows x64 在 CI 中执行真实 daemon、RPC、`tools.list` 和 PowerShell `bash_run` smoke。Windows ARM64 在 Windows runner 上执行交叉编译和发布资产构建。
