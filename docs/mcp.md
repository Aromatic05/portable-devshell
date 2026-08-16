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

## 全局 listener 配置

编辑 `~/.devshell/control/config.toml`：

```toml
version = 2

[control]
logLevel = "info"

[mcp]
enabled = true
listenHost = "127.0.0.1"
listenPort = 17890
publicBaseUrl = "http://127.0.0.1:17890"
```

全局 `[mcp]` 只管理 listener，不包含认证。认证由每个 instance 文件中的 `[mcp]` 独立配置。

## Instance 配置与独立认证

编辑 `~/.devshell/control/instances/demo-local.toml`：

```toml
version = 3
name = "demo-local"
enabled = true
provider = "local"

[mcp]
enabled = true
auth = "none"
path = "/demo-local/mcp"

[mcp.tools]
groups = ["file", "bash", "artifact", "tmux", "todo"]
capabilities = ["read", "write", "execute"]
```

同一 listener 下可以分别配置：

```toml
# instance A
[mcp]
enabled = true
auth = "none"
path = "/open-local/mcp"
```

```toml
# instance B
[mcp]
enabled = true
auth = "token"
token = "replace-with-a-random-secret-of-at-least-32-bytes"
path = "/token-local/mcp"
```

```toml
# instance C
[mcp]
enabled = true
auth = "oauth2"
path = "/oauth-local/mcp"

[mcp.oauth2]
resourceName = "oauth-local"
requiredScopes = ["mcp"]
```

工具策略只通过 `[mcp.tools]` 下的 `groups` 和 `capabilities` 表达。`path` 固定为 `/<instance>/mcp`，由 instance 名生成。

## 工具组与能力

工具是否出现，需要同时满足所属 group 已启用、所需 capability 已授予。

| Group      | 主要工具                                                                                 | 常见 capability   |
| ---------- | ---------------------------------------------------------------------------------------- | ----------------- |
| `bash`     | `bash_run`                                                                               | `execute`         |
| `file`     | `file_read`、`file_edit`、`file_find`、`file_search`、`file_info`          | `read`、`write`   |
| `artifact` | `artifact_read`、`artifact_viewImage`、`artifact_share`、`artifact_transfer`             | `read`、`write`   |
| `tmux`     | `tmux_run`、`tmux_input`、`tmux_read`、`tmux_inspect`、`tmux_list`、`tmux_create`、`tmux_close`    | `read`、`execute` |
| `todo`     | `todo_read`、`todo_write`                                                                | 无硬性 capability |
| `instance` | `instance_list`、`instance_status`、`instance_create`、`instance_connect`、`instance_stop` | `manage`          |

默认不包含 `instance` group，也不授予 `manage`。`instance_connect` 是幂等的“确保可用”入口：目标未启动时由 Control 启动并连接，已经 ready 时不重复启动；可选 `workspace` 会作为当前 `ctxId` 在该 instance 上的 workspace attachment。`selfManaged` reverse worker 不由 Control 启动，`instance_connect` 只接受已经连入的 worker。`instance_stop` 仍只适用于由 Control 管理生命周期的 worker。用户从 TUI 定向发送给某个 Context 的 Comment 不作为独立 MCP 工具暴露；消息按 `ctxId` 排队，并附着到该 Context 下一次成功的普通工具结果中。

## Skills 与项目记忆提示

Control 机器上的 Skill 目录固定为：

```text
~/.devshell/skill
```

- local instance 直接使用同一台机器上的目录，不进行复制；
- SSH、Docker 和 Podman instance 在启动或重新连接 worker 时，将该目录镜像到 worker 用户的 `~/.devshell/skill`；
- self-managed reverse instance 由 worker 所在机器自行维护该目录，Control 不主动推送。

`environ_info` 接收 `workspace` 参数；它是 **worker 机器上的绝对目录**，由调用方在自己已获准访问的目录范围内选择。返回值包含 canonical workspace、worker 上展开后的绝对 `skillsDirectory`，并提示 Agent 按需读取其中相关 Skill 的 `SKILL.md`。

`environ_info` 还会提示：**Every project may contain `AGENT.md`**。Agent 在同时处理多个项目时，应分别读取、遵守和维护每个项目适用的 `AGENT.md`，不能把某个项目的项目记忆当成 instance 全局规则。

每个 workspace 还会得到两类辅助目录：

- `projectMemoryDirectory`：位于 worker 的 `~/.devshell/project-memory/` 下，按 canonical workspace 的稳定平台路径表示生成持久 key；其中的 `AGENT.md` 可跨 Context 长期保留；
- `temporaryDirectory`：对外路径稳定在 worker 的 `~/.devshell/context-tmp/` 下，每个 Context 独立。Unix worker 会把这个固定入口维护为指向 transient runtime storage 的符号链接，优先使用 `$XDG_RUNTIME_DIR/devshell-worker/context-tmp`；Linux 缺少 `XDG_RUNTIME_DIR` 时优先使用 `/dev/shm`，避免高频临时数据写入持久 home。有效 Context 的后续工具调用会刷新该目录活跃时间；连续 24 小时未活动的临时目录可在后续 workspace 初始化时被 GC。若 runtime storage 因重启、GC 或 worker replacement 消失，本次工具调用会重新 prepare 同一 workspace、持久化新的临时目录后继续执行。

如果 instance 配置了 `[alerts]`，`environ_info` 同时读取该 workspace 的 alert advice，并启动该 workspace 的周期 probe。`instance_connect` 附加 workspace 时执行同样的准备。有效 Context 在各 instance 上的后续工具调用会分别刷新对应 workspace 的 alert 活跃租约并同步当前 alerts 配置；最后一个持有某个 instance/workspace attachment 的 Context 被手动禁用时立即释放该租约，连续 24 小时无有效调用时也会自动停止 probe 并移除缓存状态。

Context registry 永远保留全部 active Context；expired / disabled 终态历史默认只保留最近 256 条，并在正常运行期间持续压缩，不依赖 Control 重启。被历史压缩淘汰的旧 `ctxId` 后续按无效 Context 处理。

## 可选实例管理与跨实例路由

只有显式配置：

```toml
[mcp.tools]
groups = ["file", "bash", "artifact", "tmux", "todo", "instance"]
capabilities = ["read", "write", "execute", "manage"]
```

当前 endpoint 才会暴露实例管理工具。此时其他 worker 工具还会获得可选 `instance` 参数，用于把调用路由到另一个受管实例。

这是高权限能力，不应默认用于公网 endpoint。

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

## 请求取消

MCP `notifications/cancelled` 会沿当前工具调用链传播到 control、worker RPC 和目标 worker。同步 HTTP `tools/call` 在客户端或网关提前断开响应连接时也会触发同一取消链路，不要求客户端额外发送取消通知。取消不是回滚协议，各工具按自身语义处理：

```text
排队 / 等待审批    立即取消，不进入 worker 执行
bash_run           终止对应进程组
file_read/search   在扫描或读取安全点停止
file_edit          在预检和子操作边界停止；已完成的原子子操作不回滚
artifact_read      在读取前后停止
artifact_viewImage 在 payload 分块读取边界停止，并关闭临时 lease
control 侧工具     立即停止 MCP 等待；已经开始的生命周期或原子操作继续完成
tmux_run           停止等待，已经启动的 task 继续运行
tmux_read          停止等待且不消费尚未返回的输出
```

worker handshake 返回 `cancel = true`。本地 RPC、WSS 和 SSE + HTTPS POST 反向连接都允许取消请求在长工具运行期间到达 worker。工具调用历史使用 `cancelled`，等待审批时还会产生 `approval.cancelled`。

## 本地与公网

- `mode = "none"`、`token` 和 `oauth2` 均可用于本机、内网或公网监听；
- control 不根据 `listenHost` 或 `publicBaseUrl` 猜测防火墙、反向代理和网络信任边界；
- 无认证 endpoint 的访问控制与暴露范围由部署者负责；
- 给 ChatGPT Connector 使用时，必须通过公网 HTTPS 地址访问，并按客户端要求配置认证。

公网配置见 [oauth.md](oauth.md)。
