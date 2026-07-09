# portable-devshell

`portable-devshell` 用来把一个本地、SSH 或容器里的工作区包装成可启动的 instance，并通过 MCP 暴露给 `Codex`、`Claude Code`、`ChatGPT Connector` 等客户端。

## 有哪些功能

- 用一个 control daemon 统一管理多个 instance。
- 每个 instance 绑定一个 workspace，可单独启动、停止、查看状态和日志。
- 通过 HTTP 暴露 MCP，每个 instance 对应一个 `/<instance>/mcp` endpoint。
- 支持本地 `localhost` MCP，也支持带 OAuth 的公网 MCP。
- 支持 `local`、`ssh`、`docker`、`podman` 四种 provider。

## 如何快速开始

从源码仓库运行时，先构建 TypeScript CLI 和 Rust worker：

```bash
pnpm install
pnpm build
cargo build -p devshell-worker --manifest-path ./Cargo.toml
```

然后启动 control daemon。第一次启动会自动创建默认配置：

```bash
node packages/cli/dist/cli/CliMain.js start
```

接着创建一个 instance，并按提示填写 `name`、`workspace`、`provider`、`MCP enabled` 等字段：

```bash
node packages/cli/dist/cli/CliMain.js instance create
```

最后启动 instance：

```bash
node packages/cli/dist/cli/CliMain.js instance start <instance>
```

更完整的首次启动说明见 [docs/quickstart.md](docs/quickstart.md)。

## 如何启动 MCP

要让某个 instance 暴露 MCP，需要同时满足两件事：

- 全局 `mcp.enabled = true`
- 该 instance 自己的 `[mcp] enabled = true`

默认 endpoint 形如：

```text
http://127.0.0.1:17890/<instance>/mcp
```

详细配置、验证方法和示例见 [docs/mcp.md](docs/mcp.md)。

## 如何启用 OAuth

如果你要把 MCP 暴露到公网，建议直接使用 `mcp.auth.mode = "oauth2"`。`portable-devshell` 会同时提供 OAuth 保护资源元数据和授权服务器。

最小示例：

```toml
[mcp]
enabled = true
listenHost = "0.0.0.0"
listenPort = 17890
publicBaseUrl = "https://devshell.example.com"

[mcp.auth]
mode = "oauth2"

[mcp.auth.oauth2]
resourceName = "portable-devshell"
requiredScopes = ["mcp"]
```

完整字段和调试入口见 [docs/oauth.md](docs/oauth.md)。

## 如何接入 Codex

把某个 instance 的 MCP endpoint 加到 Codex 的 MCP 配置里即可，例如：

```toml
[mcp_servers.portable_devshell]
url = "http://127.0.0.1:17890/<instance>/mcp"
```

如果 endpoint 开了 OAuth，再执行一次登录即可。详细步骤见 [docs/clients.md#codex](docs/clients.md#codex)。

## 如何接入 Claude Code

Claude Code 可以直接把这个 endpoint 作为远程 HTTP MCP server 添加进去：

```bash
claude mcp add --transport http portable-devshell http://127.0.0.1:17890/<instance>/mcp
```

如果 endpoint 开了 OAuth，再执行登录。详细步骤见 [docs/clients.md#claude-code](docs/clients.md#claude-code)。

## 如何接入 ChatGPT Connector

ChatGPT Connector 需要一个可从 ChatGPT 访问的 HTTPS MCP endpoint。把公网地址填成：

```text
https://devshell.example.com/<instance>/mcp
```

如果启用了 OAuth，ChatGPT 会按 MCP/OAuth 流程完成授权。详细步骤见 [docs/clients.md#chatgpt-connector](docs/clients.md#chatgpt-connector)。

## 更多文档

- [docs/README.md](docs/README.md)
- [docs/quickstart.md](docs/quickstart.md)
- [docs/mcp.md](docs/mcp.md)
- [docs/oauth.md](docs/oauth.md)
- [docs/clients.md](docs/clients.md)
- [docs/reference.md](docs/reference.md)
