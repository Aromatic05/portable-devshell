# OAuth 与公网暴露

把 MCP 暴露到公网时，推荐使用内置 OAuth 2.1 provider。公网地址不可用“难以猜测的 URL”代替认证。

## 推荐拓扑

control 仍监听本机回环地址，由反向代理或隧道提供公网 HTTPS：

```text
MCP client → HTTPS proxy/tunnel → 127.0.0.1:17890 → portable-devshell
```

这样不需要直接把 control 的 HTTP 端口暴露到公网。

## 全局配置

编辑 `~/.devshell/control/config.toml`：

```toml
version = 1

[control]
logLevel = "info"

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
documentationUrl = "https://devshell.example.com/docs"
```

必需条件：

- `mcp.enabled = true`；
- `publicBaseUrl` 与客户端实际访问的 HTTPS 根地址一致；
- `mcp.auth.mode = "oauth2"`；
- `resourceName` 非空。

`documentationUrl` 可选。

## 实例配置

每个要暴露的实例仍需单独启用 MCP：

```toml
version = 2
name = "demo-local"
enabled = true
provider = "local"
workspace = "/absolute/path/to/workspace"

[mcp]
enabled = true

[mcp.tools]
groups = ["file", "bash", "artifact", "tmux", "todo"]
capabilities = ["read", "write", "execute"]
```

## 重启与审批

```bash
devshell stop
devshell start
devshell instance start demo-local
devshell tui
```

进入 TUI 的 `OAuth` 页面处理动态客户端注册和授权请求。待审批请求有过期时间；不要把审批留在后台长期无人处理。

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

OAuth provider 还提供注册、授权、token、撤销、JWKS 和会话相关 endpoint。

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
- 支持 MCP 的流式 HTTP 响应。

具体示例见 [chatgpt-connector-tunnels.md](chatgpt-connector-tunnels.md)。

## 安全边界

- 默认工具策略不包含 `instance + manage`；
- 不要在公网 endpoint 无条件开放实例管理；
- 高风险工具可使用 `approvalPolicy.mode = "ask"`；
- 公网配置为 `mode = "none"` 时，control 会拒绝启动。
