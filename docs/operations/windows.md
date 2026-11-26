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

\`\`\`text
bash_run
file 工具组
task_read / task_input
terminal_inspect / terminal_manage
artifact 工具组
reverse connection
\`\`\`

Windows Worker 使用同一个 binary 的 Process Host 持有普通 Pipe 和原生 ConPTY 资源，不依赖外部终端复用器。模型与人工 Attach 访问同一资源；Worker 重启后仍可接续 Process Host 中运行的任务。

\`crates/devshell-worker/tests/process_windows_contract.rs\` 是 Windows 原生进程/PTY 专项契约入口。扩展 CI 提供 x64 与 ARM64 Windows runner；构建或交叉编译成功不代表已完成真实 Windows 运行态验收。

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

每个 Windows Worker instance 使用两条独立 Named Pipe：

```text
RPC:       \\.\pipe\devshell-worker-<user>-<instance>-<runtime-hash>
Transport: \\.\pipe\devshell-worker-<user>-<instance>-<runtime-hash>-transport
```

`<user>` 是规范化后的用户名；`<runtime-hash>` 是规范化 runtime directory 路径的 BLAKE3 前 16 个十六进制字符，用来隔离不同 runtime root。不能只按用户名与 instance 拼出旧 pipe 名。路径由 `crates/devshell-worker/src/transport/endpoint/channel/paths.rs` 统一解析。

直接 RPC pipe 使用四字节大端长度前缀 JSON；transport pipe 使用与 Unix `transport.sock` 相同的 [Transport 协议](../development/transport-protocol.md)：Channel → Frame v1 单一 `envelope` Service → 带 source/destination host/port 的 Protobuf Envelope → Rpc/Event/Stream Packet。二进制 Stream DATA 不编码成 JSON/base64。两条 pipe 由 daemon 分别监听，不能把直接 RPC 编码套用于所有 Worker 连接。

## 发布 target

```text
windows-x64      x86_64-pc-windows-msvc
windows-arm64    aarch64-pc-windows-msvc
```

当前 CI/Release 对 Windows x64 与 ARM64 都保证应用包和原生 Worker target 的构建/打包。通用 TypeScript/Rust 正确性由 common gate 证明；Windows runner **不再宣称覆盖与 Unix 等价的 PowerShell/ConPTY runtime smoke**，因为这些交互与终端语义目前缺少足够稳定、有证明力的自动化测试。

因此“Windows target 构建成功”不能被解释成所有 Windows runtime 交互都已经过真实验收。发布门禁的准确范围见 [验收与发布门禁](../development/acceptance.md)。
