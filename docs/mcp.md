# 启动 MCP

`portable-devshell` 的 MCP 是按 instance 暴露的。每个已启用的 instance 都对应一个独立 endpoint：

```text
/<instance>/mcp
```

它不是实例管理 API；你要管理 instance，仍然用 CLI 和 control daemon。

## 需要打开的两层开关

要让某个 instance 真正暴露 MCP，需要同时打开：

1. 全局 MCP 开关
2. 该 instance 自己的 MCP 开关

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
publicBaseUrl = "http://127.0.0.1:17890"

[mcp.auth]
mode = "none"
```

这个配置适合本机 `localhost` 调试。

## 实例配置

编辑 `~/.devshell/control/instances/<instance>.toml`：

```toml
version = 1
name = "demo"
enabled = true
provider = "local"
workspace = "/path/to/workspace"

[mcp]
enabled = true
allowTools = ["bash_run"]
```

只有同时满足全局 `[mcp] enabled = true` 和实例 `[mcp] enabled = true`，`/<instance>/mcp` 才会出现。

## 重新启动 control

改完全局配置后，重启 control daemon：

```bash
node packages/cli/dist/cli/CliMain.js stop
node packages/cli/dist/cli/CliMain.js start
```

然后启动目标 instance：

```bash
node packages/cli/dist/cli/CliMain.js instance start <instance>
```

## Endpoint 规则

- 默认 URL: `http://127.0.0.1:17890/<instance>/mcp`
- 如果实例显式配置了 `[mcp] path = "/custom/mcp"`，就会使用自定义 path
- 只有启用了 MCP 的 instance 会被注册到 HTTP host

## 最小验证

先确认实例已就绪：

```bash
node packages/cli/dist/cli/CliMain.js instance status <instance>
```

然后发一个最小 `initialize` 请求：

```bash
curl -i http://127.0.0.1:17890/<instance>/mcp \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": "req-init",
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {
        "name": "manual-check",
        "version": "0.0.0"
      }
    }
  }'
```

正常情况下会返回 `200`，并带上 `mcp-session-id` 响应头。

## 本地和公网的区别

- `listenHost = "127.0.0.1"`: 适合本机调试和本地客户端
- `listenHost = "0.0.0.0"` 或公网 `publicBaseUrl`: 视为公网暴露，必须配认证

如果你要给 `Codex`、`Claude Code`、`ChatGPT Connector` 使用公网地址，继续看 [oauth.md](oauth.md)。
