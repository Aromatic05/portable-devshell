# portable-devshell

`portable-devshell` 把本地、SSH、容器和反向连接目标统一成可管理的 **instance**，并通过 CLI、TUI 和 MCP 暴露同一套开发环境能力。

一个长期运行的 TypeScript Control daemon 管理实例、配置、审批、审计、Context、Workspace、OAuth 与 HTTP host；每个目标环境运行独立的 Rust worker daemon。所有入口最终经过同一套 worker 工具调用链。

## 主要能力

* `local`、`ssh`、`docker`、`podman`、`reverse` 五种 provider。
* 每个 instance 独立 worker、生命周期、日志、审批策略和 MCP endpoint。
* workspace 不持久化到 instance；CLI 操作显式给出路径，MCP 通过 Context 为每个 instance 绑定 workspace。
* `bash`、`file`、`tmux`、`artifact`、`todo`、Workspace 以及可选跨实例连接。
* managed tmux task、persistent pane、durable Wait 和 Workspace 自动恢复。
* MCP TypeScript SDK v2；支持 2026-07-28 语义并保留旧 Streamable HTTP 客户端兼容。
* request-scoped SSE keepalive，使长时间 `tools/call` 不因 HTTP idle timeout 被提前切断。
* OAuth、Artifact 分享与跨实例传输、分层 Agent Skills、Secret 扫描、运行时 Debug Patch。
* 全屏 TUI 与完整 Control CLI。

## 安装

发布包支持 Linux、macOS 和 Windows 的 x86-64 / arm64。主程序需要 Node.js 24 或更高版本；Release 安装不要求 pnpm 或 Rust。

Unix：

```bash
curl -fLO https://github.com/Aromatic05/portable-devshell/releases/latest/download/install-release.sh
curl -fLO https://github.com/Aromatic05/portable-devshell/releases/latest/download/install-release.sh.sha256

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c install-release.sh.sha256
else
  shasum -a 256 -c install-release.sh.sha256
fi

sh install-release.sh
```

Windows PowerShell：

```powershell
Invoke-WebRequest https://github.com/Aromatic05/portable-devshell/releases/latest/download/install-release.ps1 -OutFile install-release.ps1
Invoke-WebRequest https://github.com/Aromatic05/portable-devshell/releases/latest/download/install-release.ps1.sha256 -OutFile install-release.ps1.sha256
$expected = ((Get-Content install-release.ps1.sha256 -TotalCount 1) -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 install-release.ps1).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "SHA-256 verification failed" }
powershell -ExecutionPolicy Bypass -File .\install-release.ps1
```

从源码：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm install:local
```

升级时安装器会在版本切换前记录 Control 管理的运行中实例，在新版本启动后恢复它们；Reverse instance 仍由远端自行重连。

完整说明见 [安装与升级](docs/getting-started/installation.md)。

## 快速开始

```bash
devshell start
devshell instance create
devshell instance start demo-local
devshell instance status demo-local
```

实例名必须包含连字符，例如 `demo-local`。

验证 worker：

```bash
devshell instance call demo-local /absolute/path/to/project bash_run '{"command":"pwd","timeoutMs":30000}'
```

打开 TUI：

```bash
devshell tui
```

完整流程见 [快速开始](docs/getting-started/quickstart.md)。

## MCP

全局 MCP host 与目标 instance 的 MCP 都启用后，默认 endpoint 为：

```text
http://127.0.0.1:17890/<instance>/mcp
```

MCP `tools/list` 使用固定 runtime catalog，不再按 instance 配置动态裁剪。模型通过
`bash_run` / `tmux_run` 中的 Context-bound `devshell` 使用 Extension command；可用 root
由当前 instance 的 `[extensions].model` allowlist 决定：

```toml
[mcp]
enabled = true

[extensions]
model = ["artifact", "instance", "mcp", "secret", "skill"]
```

跨 instance Context attachment 使用固定 MCP runtime primitive `environ_remote`。模型先通过
`devshell instance list` / `devshell instance status <instance>` 获取当前 Context 下的 opaque
instance handle，再调用 `environ_remote` 的 `attach` command。`mask` command 可以永久屏蔽当前
Context 对某个 remote instance 的访问，直到该 Context 结束；不存在 unmask。旧
`instance_connect` 不再暴露。model command 不会 fallback 到 native/builtin CLI。

Workspace App/Goal/Wait recovery 可以按 instance 独立关闭，而不停止 Worker 或 MCP runtime：

```toml
[workspace]
enabled = false
```

普通 MCP 客户端可以使用 `explicit` Context；支持稳定 Host metadata 的 ChatGPT endpoint 可使用 `openai-session`，让 model-facing 工具不携带内部 `ctxId`。两种模式最终都解析到 portable-devshell 自己的 Context。

`tmux_run(wait=block)` 当前产品同步窗口统一为 **180 秒**。MCP HTTP host 使用 request-scoped SSE 和 15 秒 keepalive；如果 task 在 180 秒内结束，tool call 直接返回结果，否则转成 durable Wait，由 Workspace 继续跟踪而不停止 task。

详细说明见 [MCP](docs/concepts/mcp.md)、[Context](docs/concepts/context.md) 和 [Workspace](docs/concepts/workspace.md)。

## 公网与 OAuth

公网 endpoint 应使用 HTTPS 和认证。常见拓扑是 Control 仅监听 loopback，由 Nginx、FRP 或 Cloudflare Tunnel 提供公网 HTTPS：

```toml
# ~/.devshell/control/config.toml
[mcp]
enabled = true
listenHost = "127.0.0.1"
listenPort = 17890
publicBaseUrl = "https://devshell.example.com"
```

instance 再独立选择 `auth = "oauth2"`。

参见 [OAuth 与公网暴露](docs/operations/oauth.md) 和 [ChatGPT 公网隧道](docs/operations/chatgpt-tunnels.md)。

## 文档

* [文档索引](docs/README.md)
* [系统架构](docs/concepts/architecture.md)
* [MCP](docs/concepts/mcp.md)
* [Context](docs/concepts/context.md)
* [Workspace](docs/concepts/workspace.md)
* [Control 管理面](docs/operations/control-plane.md)
* [配置与运行目录](docs/operations/configuration.md)
* [安全、审批与 Secret 扫描](docs/operations/security.md)
* [tmux 工具](docs/tools/tmux.md)
* [Agent Skills](docs/tools/skills.md)
* [验收与发布门禁](docs/development/acceptance.md)
