# portable-devshell

`portable-devshell` 把本地、SSH、容器或反向连接设备中的工作区统一成可管理的 instance，并通过 MCP 暴露给 Codex、Claude Code、ChatGPT Connector 等客户端。

它采用一个长期运行的 TypeScript control daemon 管理多个 instance；每个目标环境运行独立的 Rust worker daemon。CLI、TUI 和 MCP 共用同一套状态、审批、审计和工具调用链。

## 主要能力

- `local`、`ssh`、`docker`、`podman`、`reverse` 五种 provider。
- 每个 instance 独立 workspace、生命周期、日志、审批策略和 MCP endpoint。
- 克制的系统级工具面：`bash`、`file`、`tmux`、`artifact`、`todo`，以及可选实例管理。
- WSS 反向连接，SSE + HTTPS POST 回退。
- OAuth 2.1、动态客户端注册、持久化密钥、刷新与撤销。
- 文件与目录分享、断点读取、跨实例异步传输和 BLAKE3 校验。
- 全屏 TUI：实例、配置、Connector、OAuth、审计、日志和 Todo。

## 安装

发布包支持 Linux、macOS 和 Windows 的 x86-64、arm64，主程序需要 Node.js 24 或更高版本。安装器会预置六个平台的 worker，因为 control 主机与受管目标环境可以不是同一平台。

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

从源码安装：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm install:local
```

完整说明见 [docs/installation.md](docs/installation.md)。

## 第一次启动

```bash
devshell start
devshell instance create
devshell instance start demo-local
devshell instance status demo-local
```

实例名必须包含连字符，例如 `demo-local`。第一次使用建议选择：

```text
provider: local
workspace: 当前项目目录
MCP enabled: yes
```

验证 worker 调用：

```bash
devshell instance call demo-local bash_run '{"command":"pwd"}'
```

打开 TUI：

```bash
devshell tui
```

完整上手流程见 [docs/quickstart.md](docs/quickstart.md)。

## MCP

全局 MCP 和实例 MCP 都启用后，默认 endpoint 为：

```text
http://127.0.0.1:17890/<instance>/mcp
```

实例工具策略使用 group 和 capability：

```toml
[mcp]
enabled = true

[mcp.tools]
groups = ["file", "bash", "artifact", "tmux", "todo"]
capabilities = ["read", "write", "execute"]
```

详细说明见 [docs/mcp.md](docs/mcp.md)。

## 公网与 OAuth

公网暴露必须启用认证。常用配置：

```toml
[mcp]
enabled = true
listenHost = "127.0.0.1"
listenPort = 17890
publicBaseUrl = "https://devshell.example.com"

[mcp.auth]
mode = "oauth2"

[mcp.auth.oauth2]
resourceName = "portable-devshell"
requiredScopes = ["mcp"]
```

通过 Nginx、FRP 或 Cloudflare Tunnel 暴露同一 HTTP host。详细说明见 [docs/oauth.md](docs/oauth.md) 和 [docs/chatgpt-connector-tunnels.md](docs/chatgpt-connector-tunnels.md)。

## 文档

- [文档索引](docs/README.md)
- [安装与升级](docs/installation.md)
- [快速开始](docs/quickstart.md)
- [Windows 支持](docs/windows.md)
- [当前架构](docs/architecture.md)
- [MCP](docs/mcp.md)
- [OAuth](docs/oauth.md)
- [客户端接入](docs/clients.md)
- [参考信息](docs/reference.md)
