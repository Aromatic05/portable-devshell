# MCP 配置与工具策略

`portable-devshell` 按 instance 暴露 MCP。默认路径为：

```text
/<instance>/mcp
```

例如：

```text
http://127.0.0.1:17890/demo-local/mcp
```

## 两层开关

endpoint 出现需要同时满足：

1. 全局 `mcp.enabled = true`；
2. 实例 `[mcp].enabled = true`。

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

这只适合 localhost。公网暴露必须启用认证。

## 实例配置

编辑 `~/.devshell/control/instances/demo-local.toml`：

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

工具策略只通过 `[mcp.tools]` 下的 `groups` 和 `capabilities` 表达。

## 工具组与能力

工具是否出现，需要同时满足所属 group 已启用、所需 capability 已授予。

| Group      | 主要工具                                                                                 | 常见 capability   |
| ---------- | ---------------------------------------------------------------------------------------- | ----------------- |
| `bash`     | `bash_run`                                                                               | `execute`         |
| `file`     | `file_read`、`file_edit`、`file_write`、`file_find`、`file_search`、`file_info`          | `read`、`write`   |
| `artifact` | `artifact_read`、`artifact_share`、`artifact_transfer`                                   | `read`、`write`   |
| `tmux`     | `tmux_send`、`tmux_capture`、`tmux_inspect`、`tmux_list`、`tmux_create`、`tmux_close`    | `read`、`execute` |
| `todo`     | `todo_read`、`todo_write`                                                                | 无硬性 capability |
| `instance` | `instance_list`、`instance_status`、`instance_create`、`instance_start`、`instance_stop` | `manage`          |

默认创建的实例不包含 `instance` group，也不授予 `manage`。

## 可选实例管理与跨实例路由

只有显式配置：

```toml
[mcp.tools]
groups = ["file", "bash", "artifact", "tmux", "todo", "instance"]
capabilities = ["read", "write", "execute", "manage"]
```

当前 endpoint 才会暴露实例管理工具。此时其他 worker 工具还会获得可选 `instance` 参数，用于把调用路由到另一个受管实例。

这是高权限能力，不应默认用于公网 endpoint。

## 自定义路径

实例可以覆盖默认路径：

```toml
[mcp]
enabled = true
path = "/custom/mcp"
```

路径必须在同一个 MCP HTTP host 上保持唯一。

## 应用配置

手动修改全局配置后重启 control：

```bash
devshell stop
devshell start
```

然后启动实例：

```bash
devshell instance start demo-local
```

## 手动验证

先确认实例就绪：

```bash
devshell instance status demo-local
```

发送 MCP `initialize`：

```bash
curl -i http://127.0.0.1:17890/demo-local/mcp \
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

正常情况下返回 `200`，并包含 `mcp-session-id`。

## 本地与公网

- `127.0.0.1` + localhost `publicBaseUrl`：可使用 `mode = "none"`；
- `0.0.0.0` 或非 localhost `publicBaseUrl`：必须启用认证；
- 给 ChatGPT Connector 使用时，必须通过公网 HTTPS 地址访问。

公网配置见 [oauth.md](oauth.md)。
