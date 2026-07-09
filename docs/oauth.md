# 启用 OAuth

如果你准备把 `portable-devshell` 的 MCP 暴露给公网客户端，推荐直接使用 `mcp.auth.mode = "oauth2"`。

## 什么时候必须开认证

下面两种情况都属于公网暴露：

- `listenHost = "0.0.0.0"`
- `publicBaseUrl` 不是 `localhost`

这时不能继续用 `mcp.auth.mode = "none"`。

## 全局配置示例

编辑 `~/.devshell/control/config.toml`：

```toml
version = 1

[control]
logLevel = "info"

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
documentationUrl = "https://docs.example.com/portable-devshell"
```

至少需要保证：

- `mcp.enabled = true`
- `mcp.publicBaseUrl` 可从外部访问
- `mcp.auth.mode = "oauth2"`
- `mcp.auth.oauth2.resourceName` 已设置

`documentationUrl` 可选，但建议填一个你自己的使用说明页。

## 实例仍然要单独打开 MCP

OAuth 只保护 HTTP host，本身不会替你暴露实例。

目标实例仍然需要在 `~/.devshell/control/instances/<instance>.toml` 里打开：

```toml
[mcp]
enabled = true
allowTools = ["bash_run"]
```

## 重启 control 并启动实例

```bash
node packages/cli/dist/cli/CliMain.js stop
node packages/cli/dist/cli/CliMain.js start
node packages/cli/dist/cli/CliMain.js instance start <instance>
```

## 会出现哪些 URL

假设：

- `publicBaseUrl = "https://devshell.example.com"`
- instance 名称是 `demo`

那么你会得到：

- MCP endpoint: `https://devshell.example.com/demo/mcp`
- protected resource metadata: `https://devshell.example.com/.well-known/oauth-protected-resource/demo/mcp`
- authorization server metadata: `https://devshell.example.com/.well-known/openid-configuration`

客户端第一次连接时，会先发现这些元数据，再进入浏览器登录流程。

## 认证流程说明

- `portable-devshell` 自己暴露受保护资源元数据
- 同一个 `publicBaseUrl` 下也会提供 OAuth / OIDC 授权服务器元数据
- 用户登录和授权在浏览器里完成
- 客户端拿到 access token 后，再访问 `/<instance>/mcp`

## 调试建议

如果客户端连不上，先按这个顺序检查：

1. `https://devshell.example.com/demo/mcp` 是否可访问
2. `https://devshell.example.com/.well-known/oauth-protected-resource/demo/mcp` 是否返回 JSON
3. `https://devshell.example.com/.well-known/openid-configuration` 是否返回 JSON
4. instance 是否已经 `ready`

## 下一步

- 想接入 Codex、Claude Code、ChatGPT：见 [clients.md](clients.md)
- 想看路径、配置文件和 worker 细节：见 [reference.md](reference.md)
