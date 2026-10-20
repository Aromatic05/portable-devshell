# OAuth 与公网暴露

把 MCP 暴露到公网时，推荐使用内置 OAuth 2.1 provider。公网地址不可用“难以猜测的 URL”代替认证。

## 推荐拓扑

control 仍监听本机回环地址，由反向代理或隧道提供公网 HTTPS：

```text
MCP client → HTTPS proxy/tunnel → 127.0.0.1:17890 → portable-devshell
```

这样不需要直接把 control 的 HTTP 端口暴露到公网。

## 全局 listener 配置

编辑 `~/.devshell/control/config.toml`：

```toml
version = 2

[control]
artifactDirectTransfer = false
logLevel = "info"

[mcp]
enabled = true
listenHost = "127.0.0.1"
listenPort = 17890
publicBaseUrl = "https://devshell.example.com"
```

endpoint 的 MCP auth 仍由 instance 选择；全局文件同时管理 Listener/public URL 与 OAuth approval 模式、token。fresh `devshell init` 使用 token 模式并输出 approval token，用于浏览器授权页确认。全局配置可以包含：

```toml
[mcp.oauth2]
approval = "token"
token = "<init-generated-approval-token>"
```

已有全局文件完全缺少 `[mcp.oauth2]` 时保留 `tui` 默认；显式提供 OAuth draft 但未指定 approval 时默认 `token`。不要把这两种路径混为一谈。Control 持有物理 HTTP Listener，OAuth/MCP 使用注入的 route/lease。

## Instance OAuth 配置

每个需要 OAuth 的 instance 独立配置：

```toml
version = 4
name = "demo-local"
enabled = true
provider = "local"

[mcp]
enabled = true
auth = "oauth2"
path = "/demo-local/mcp"

[mcp.oauth2]
resourceName = "demo-local"
requiredScopes = ["mcp"]
documentationUrl = "https://devshell.example.com/docs"

[extensions]
model = ["instance"]
```

必需条件：

- 全局 `mcp.enabled = true`；
- 全局 `publicBaseUrl` 与客户端实际访问的 HTTPS 根地址一致；
- 目标 instance 的 `[mcp].enabled = true`；
- 目标 instance 的 `[mcp].auth = "oauth2"`；
- `[mcp.oauth2].resourceName` 非空。

`documentationUrl` 可选。不同 instance 可以配置不同 OAuth scope；也可以让其他 instance 使用 `none` 或独立 token。MCP `tools/list` 会把 instance 的认证策略显式投影到每个 tool：`none` 广告 `securitySchemes = [{ type = "noauth" }]`，`oauth2` 广告配置的 OAuth scopes，并同步写入兼容 `_meta.securitySchemes`。这样 ChatGPT 能把 protected-resource discovery、tool metadata 与运行时认证 challenge 关联起来。

## 应用配置与审批

```bash
devshell config get
devshell instance status demo-local
```

Control 配置 API 会热应用支持的 listener/endpoint 变化，并在确实需要时报告 restart requirement；不要把所有 OAuth 配置变更都固定写成一次完整 Control restart。

fresh init 默认使用 token 审批：在浏览器授权页输入 init 输出的 approval token，确认 registration 与 authorization；TUI 不是必经步骤。显式配置全局 `[mcp.oauth2] approval = "tui"` 时，才在 `devshell tui` 的 OAuth 页面或对应 CLI 接口处理请求。provider 为首次出现的 `client_id` 建立 registration 审批，随后处理 authorization；两者有各自生命周期和过期时间。

Provider 采用 MCP 2026-07-28 的 OAuth Client ID Metadata Document（CIMD）进行客户端身份识别：客户端把 `client_id` 设为自身 HTTPS 元数据文档 URL，provider 直接在授权时获取并校验该文档（`client_id` 必须与 URL 精确一致，redirect URI 必须命中文档声明，SSRF 由内置 socket 防护与策略共同约束）。旧的 Dynamic Client Registration（`/register`）端点已移除。已预先注册的客户端（写入 Client adapter 的静态客户端，包括历史 DCR 已注册的客户端）继续可用；其 `client_id` 不以 `https://` 开头时按预注册处理，已有 token / refresh / revoke 生命周期不受影响，但不能再通过 DCR 新建客户端。新客户端请使用 CIMD，或通过预先配置注册。

## URL

假设：

```text
publicBaseUrl = https://devshell.example.com
instance = demo-local
```

主要入口为：

```text
MCP endpoint
https://devshell.example.com/demo-local/mcp

受保护资源元数据
https://devshell.example.com/.well-known/oauth-protected-resource/demo-local/mcp

OpenID/OAuth 元数据
https://devshell.example.com/.well-known/openid-configuration
```

OAuth provider 还提供授权、token、撤销、JWKS 和会话相关 endpoint；不再提供 Dynamic Client Registration（`/register`）。

## 持久化

OAuth 客户端、授权状态、token 数据和签名密钥保存在：

```text
~/.devshell/control/oauth/
```

升级时不要删除该目录，否则已有客户端和授权状态会失效。

## 代理要求

反向代理必须：

- 保留 `Authorization` header；
- 正确转发 method、query 和 request body；
- 不缓存 OAuth 与 MCP 响应；
- 保持 `publicBaseUrl` 对应的 scheme、host 和 path；
- 支持 MCP 的 request-scoped SSE 流式响应；
- 关闭 response buffering，确保长 `tools/call` 的 1 秒 keepalive frame 能及时到达 Host（其他请求为 auto handler / 15 秒 keepalive）；
- 对长 `tools/call` 配置足够的 read/send timeout。

具体示例见 [ChatGPT 公网隧道](chatgpt-tunnels.md)。

## 安全边界

- 默认工具策略不包含 `instance + manage`；
- 不要在公网 endpoint 无条件开放实例管理；
- 高风险工具可使用 `approvalPolicy.mode = "ask"`；
- `mode = "none"` 在公网、内网和本机部署中均允许；control 不推断防火墙、反向代理或网络边界。
- 选择无认证部署时，访问控制与暴露范围由部署者负责。
