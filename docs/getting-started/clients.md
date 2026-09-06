# 客户端接入

下面示例使用 `demo-local`：

```text
本地 endpoint  http://127.0.0.1:17890/demo-local/mcp
远程 endpoint  https://devshell.example.com/demo-local/mcp
```

portable-devshell 同时支持 MCP v2 的 2026-07-28 请求和 2025-era Streamable HTTP stateless fallback，因此新旧 Host 可以在同一个 endpoint 上逐步迁移。

客户端接入时需要区分三件事：

1. **网络可达性**：Host 能否访问 endpoint；
2. **认证**：`none`、静态 bearer 或 OAuth；
3. **Context selector**：通用 client 使用 `explicit`，ChatGPT 可选 `openai-session`。

## Codex

Codex 可以配置远程 HTTP MCP server。常见 `config.toml` 形式：

```toml
[mcp_servers.portable_devshell]
url = "http://127.0.0.1:17890/demo-local/mcp"
```

使用 OAuth endpoint 时把 URL 改成实际 HTTPS 地址，并使用当前 Codex 的 MCP 登录入口完成授权。

检查已配置 MCP server 时使用当前 Codex CLI 的 `mcp` 管理命令。Codex 的具体子命令和配置键可能随版本更新，portable-devshell 只依赖标准 MCP HTTP/OAuth 行为；遇到 CLI 参数差异时以当前 Codex `--help` 为准。

本地 Codex 可以直接连接 loopback endpoint；不需要为了本机开发把 Control HTTP host 暴露到公网。

## Claude Code

Claude Code 当前支持 remote HTTP MCP：

```bash
claude mcp add --transport http \
  portable-devshell \
  http://127.0.0.1:17890/demo-local/mcp
```

需要用户级复用时：

```bash
claude mcp add --transport http --scope user \
  portable-devshell \
  https://devshell.example.com/demo-local/mcp
```

管理：

```bash
claude mcp list
claude mcp get portable-devshell
claude mcp remove portable-devshell
```

OAuth remote server 通过 Claude Code 的 `/mcp` 交互入口完成浏览器认证。不要把 OAuth token 手工复制进项目配置。

## ChatGPT

ChatGPT 中的远程 MCP 现在属于自定义 **App** 能力，并可通过 Plugin 工作流发现/启用。OpenAI 的 UI、计划权限和管理员入口仍在持续变化，因此下面只记录当前稳定流程，不把某个菜单名称当成协议契约。

### 前提

* 账号/组织允许 developer mode 或自定义 MCP App；
* portable-devshell endpoint 对 ChatGPT 可达；
* write/execute 类工具的计划和 workspace policy允许完整 MCP；
* 推荐使用 portable-devshell OAuth；
* instance 已就绪，tool scan 可以读取 endpoint 的 catalog。

ChatGPT 不能直接访问普通 `127.0.0.1`。有两种网络方案：

```text
A. 公网 HTTPS / 自有反向代理 / Cloudflare / FRP
B. OpenAI Secure MCP Tunnel
```

方案 A 见 [ChatGPT 公网隧道](../operations/chatgpt-tunnels.md)。如果组织环境已经提供 Secure MCP Tunnel，可以在不把本地 server 公开到互联网的情况下连接 private/on-prem endpoint。

### 创建 App

当前 OpenAI 入口大致为：

```text
Workspace Settings -> Apps -> Create
或
Settings -> Apps -> Create
```

需要时先在 Apps 的 Advanced Settings / workspace permission 中启用 developer mode。创建时：

1. 填 portable-devshell 的完整 instance MCP URL；
2. 选择认证方式；
3. 执行 tool scan；
4. OAuth 模式完成浏览器授权；
5. 在 portable-devshell TUI/CLI 审批待处理 OAuth registration/authorization；
6. scan 完成后保存 App。

示例 URL：

```text
https://devshell.example.com/demo-local/mcp
```

不要填写 Control 根地址，也不要省略 instance path。

OpenAI workspace 管理员可能需要先审核/发布自定义 App。后续 MCP schema 变化也不一定自动应用到已批准的 App；Host 可能保留冻结的 tool snapshot，需要在管理界面 Refresh/重新审核变化。

这也是 portable-devshell 保留隐藏 stale-recipient compatibility 的原因之一。

## ChatGPT Context mode

给 ChatGPT 使用的 instance 可以配置：

```toml
[mcp]
contextMode = "openai-session"
```

这样 model-facing tool schema 不需要携带 portable-devshell 内部 `ctxId`。Host metadata 只作为 external binding；Todo、Wait、Workspace 等服务端状态仍由内部 Context 管理。

如果使用通用 client 或 Host 不提供稳定 binding，保持默认：

```toml
contextMode = "explicit"
```

详见 [Context](../concepts/context.md)。

## OAuth 与刷新

云端 Host 应优先使用 OAuth，而不是把静态 bearer secret 填进无法安全保存自定义 secret 的 UI。

portable-devshell 支持当前 legacy/compatibility 客户端仍在使用的动态客户端注册与授权流程，并保存 refresh/revocation 所需状态。MCP 2026-07-28 上游已经开始把客户端注册模型迁向新的 client identity 机制；portable-devshell 的 v2 server transport 与 OAuth compatibility path是分开的，因此协议升级不要求现有 ChatGPT/Codex/Claude 配置一次性全部重做。

详见 [OAuth](../operations/oauth.md)。

## 工具没有出现

先检查 server：

```bash
devshell status
devshell instance status demo-local
devshell instance logs demo-local
```

再检查：

1. global `mcp.enabled = true`；
2. instance `[mcp].enabled = true`；
3. tool group 已启用；
4. capability 已授予；
5. OAuth registration/authorization 已批准；
6. Host 是否使用了旧的冻结 tool snapshot；
7. `contextMode` 是否与 Host 能力匹配；
8. remote Host 到 endpoint 的 HTTPS/tunnel 链路是否真实可达。

## 长工具调用

portable-devshell 的 MCP endpoint 使用 request-scoped SSE keepalive。Host 必须允许长时间 SSE response 且中间代理不能 buffering/caching，否则即使 server 正常工作，也可能把长 `tools/call` 误判为空闲连接。

当前 `tmux_run(wait=block)` 可以在同一个 MCP tool call 中同步等待最多 180 秒，之后才进入 portable-devshell 自己的 durable handoff。

详见 [MCP](../concepts/mcp.md) 和 [tmux 工具](../tools/tmux.md)。
