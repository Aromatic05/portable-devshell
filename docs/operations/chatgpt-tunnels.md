# 通过 FRP 或 Cloudflare Tunnel 暴露 ChatGPT MCP endpoint

这份文档只讨论“自己提供公网 HTTPS endpoint”的部署方式。ChatGPT 也可以在支持的组织/产品环境中通过 OpenAI Secure MCP Tunnel 连接 private/on-prem MCP server；如果已经使用 Secure MCP Tunnel，就不需要照本文额外暴露公网入口。

直接远程 endpoint 的每个 instance 使用独立路径：

```text
https://<public-host>/<instance>/mcp
```

本指南提供两种部署方式：

| 方式              | 适用场景                                        | TLS 终止位置 |
| ----------------- | ----------------------------------------------- | ------------ |
| FRP + VPS + Nginx | 已有可控 VPS，或域名不在 Cloudflare             | VPS Nginx    |
| Cloudflare Tunnel | 域名已托管在 Cloudflare，不想维护入站端口或 VPS | Cloudflare   |

两种方式都应保留本项目的 OAuth 2.1 认证；不要以“公网地址难以猜测”代替认证。

## ChatGPT 兼容性范围

当前 compatibility path 覆盖 ChatGPT 连接远程 MCP server 所需的核心流程：

- MCP v2 request handling + 2025-era Streamable HTTP stateless fallback；
- request-scoped SSE 与 15 秒 keepalive；
- `401` Bearer challenge 与 `resource_metadata`；
- OAuth protected-resource metadata 和 authorization-server discovery；
- Dynamic Client Registration compatibility；
- public client、PKCE `S256` 和 ChatGPT 动态 callback URI；
- authorization request 与 token request 中的 RFC 8707 `resource`；
- 按 instance 校验 token audience 和 scope；
- `offline_access`、refresh token 签发和 refresh grant；
- token 撤销 endpoint；
- OAuth client、grant、token、签名密钥和 Web 内置 client ID 持久化。

Access token 默认有效期为 1 小时；refresh token、grant 和登录 session 默认保留 90 天。用户无需在 control 重启后重新注册 Web 内置 OAuth client。

MCP 2026-07-28 已把 client identity/registration 继续向新模型推进，但现有 Host 仍大量使用 DCR。portable-devshell 继续保留 DCR compatibility，而 v2 MCP transport 不依赖它。工具 schema 已提供名称、描述、输入和输出 schema；安全语义仍以实际 capability、approval policy 和工具实现为准，不能仅根据名称推断 destructive/read-only 行为。

## 公共前提

目标 instance 必须启用 MCP：

```toml
# ~/.devshell/control/instances/<instance>.toml
version = 3
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

[mcp.tools]
groups = ["file", "bash", "artifact", "tmux", "todo", "workspace"]
capabilities = ["read", "write", "execute"]
```

控制端配置公共基址并启用 OAuth：

```toml
# ~/.devshell/control/config.toml
[mcp]
enabled = true
listenHost = "127.0.0.1"
listenPort = 17890
publicBaseUrl = "https://dev.example.com"
```

修改配置后确认 runtime 已应用，并检查目标 instance：

```bash
devshell config get
devshell instance status <instance>
```

OAuth 审批不在 ChatGPT 配置页代替 portable-devshell 自身审批。运行 `devshell tui`，进入 `OAuth` 面板处理客户端实际发出的 registration / authorization 请求；审批都有生命周期，不应长期悬挂。

## 方式一：FRP + VPS + Nginx

拓扑：

```text
ChatGPT → https://dev.example.com → Nginx (VPS) → 127.0.0.1:17891 (frps) ⇄ frpc → 127.0.0.1:17890 (control)
```

### 1. 配置服务端 `frps`

在 VPS 的 `/etc/frp/frps.toml` 中只允许一个回环业务端口，并以文件令牌认证：

```toml
bindAddr = "0.0.0.0"
bindPort = 7000
proxyBindAddr = "127.0.0.1"
allowPorts = [{ single = 17891 }]

auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "/etc/frp/portable-devshell.token"
```

令牌文件必须仅允许服务账户读取，例如 `chmod 0600 /etc/frp/portable-devshell.token`。只在防火墙放行 `7000/tcp`；不要放行 `17891`。

### 2. 配置本机 `frpc`

在运行 `portable-devshell` 的机器创建 `~/.config/frp/frpc.toml`：

```toml
serverAddr = "<vps-public-ip>"
serverPort = 7000

auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "/home/<user>/.config/frp/portable-devshell.token"

[[proxies]]
name = "portable-devshell-mcp"
type = "tcp"
localIP = "127.0.0.1"
localPort = 17890
remotePort = 17891
```

将 `frpc` 配置为用户级 systemd 服务并启用 linger，确保用户注销后隧道不会停止。服务启动后，VPS 上的 `127.0.0.1:17891` 应返回 MCP 的 OAuth `401` challenge。

### 3. 在 VPS 用 Nginx 提供 HTTPS

Nginx 的通用反代需要关闭响应缓冲以支持 MCP 流式响应：

```nginx
server {
    listen 443 ssl;
    server_name dev.example.com;

    ssl_certificate /etc/letsencrypt/live/dev.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dev.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:17891;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

`proxy_buffering off` 对当前版本是功能要求而不只是性能优化：MCP handler 每 15 秒发送 SSE keepalive。如果代理把这些 frame 缓冲到很久以后才转发，Host 仍可能把一个正常的长 `tools/call` 当成 idle connection 关闭。

`portable-devshell` 在只监听回环地址时会信任反向代理提供的 `X-Forwarded-Host` 和 `X-Forwarded-Proto`，因此上面的通用 location 会直接生成正确的 HTTPS OAuth endpoint，不需要 `sub_filter` 改写响应。

使用 Certbot 或现有证书管理方式为域名签发证书。每次修改后执行 `nginx -t`，再 reload Nginx。

## 方式二：Cloudflare Tunnel

此方式在运行 `portable-devshell` 的同一台机器运行 `cloudflared`，不需要 VPS、Nginx 或开放入站端口。域名必须托管在 Cloudflare。

### 1. 创建 named tunnel 并绑定 DNS

```bash
cloudflared tunnel login
cloudflared tunnel create portable-devshell
cloudflared tunnel route dns portable-devshell dev.example.com
```

记录 `tunnel create` 输出的 UUID；`route dns` 会将 hostname 指向该 UUID 对应的 `cfargotunnel.com` 名称。

### 2. 配置 ingress

创建 `~/.cloudflared/config.yml`，让 Tunnel 直接指向本机 control：

```yaml
tunnel: <tunnel-uuid>
credentials-file: /home/<user>/.cloudflared/<tunnel-uuid>.json

ingress:
    - hostname: dev.example.com
      service: http://127.0.0.1:17890
    - service: http_status:404
```

以 systemd 系统服务安装并启动 `cloudflared`：

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

系统服务需要读取 tunnel credential；将配置和 credential 安装到服务账户可读的位置，并限制 credential 权限。运行 `cloudflared tunnel run portable-devshell` 可先进行前台调试。

不要给这个 MCP hostname 叠加需要浏览器登录的 Cloudflare Access 策略：ChatGPT 无法完成 Cloudflare 的交互式 Access 登录。这里的访问控制应由项目自身的 OAuth 和 OAuth 面板审批承担。

## 验证并在 ChatGPT 中创建 App

先验证公开发现与认证挑战：

```bash
curl -fsS https://dev.example.com/.well-known/oauth-protected-resource/<instance>/mcp
curl -fsS https://dev.example.com/.well-known/openid-configuration
curl -i https://dev.example.com/<instance>/mcp
```

前两条应返回 JSON；最后一条应返回 `401`，并带有包含 `resource_metadata` 的 `WWW-Authenticate` 头。OIDC discovery 中所有 endpoint 都必须是 `https://dev.example.com/...`。

然后在当前 ChatGPT 的 Apps/developer mode 入口创建自定义 MCP App，填入：

```text
https://dev.example.com/<instance>/mcp
```

ChatGPT 发起注册和授权后，在本机 TUI 的 `OAuth` 面板处理对应请求。完成授权后执行 tool scan/refresh。具体 UI 会随 OpenAI 产品版本变化，见 [客户端接入](../getting-started/clients.md)。

## 故障排查

- 公开 endpoint 返回 `502`：确认隧道已连接，以及上游 `127.0.0.1:17890` 正在监听。
- discovery 中出现 `http://`：确认 control 只监听 `127.0.0.1` 或 `::1`，并确认反向代理保留了 `Host`、`X-Forwarded-Host` 和 `X-Forwarded-Proto: https`。
- ChatGPT 一直等待授权：打开 TUI 的 `OAuth` 面板，检查注册或授权请求是否待批准、被拒绝或已过期。
- TUI 没有新请求：确认目标 instance 的 `[mcp] auth = "oauth2"`，并等待最多一秒让审批轮询刷新。
- 工具调用被拒绝：OAuth 授权与 instance 的 `approvalPolicy` 独立；后者控制 MCP 工具实际执行。
- 约两分钟后长工具出现 `5xx`，但 task 仍在运行：优先检查 Nginx/Cloudflare/其他中间层是否缓冲或吞掉 SSE keepalive。当前 portable-devshell 自身可以让同一个 `tools/call` 阻塞到 180 秒后再 handoff。
