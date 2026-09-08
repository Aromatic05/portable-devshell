# MCP

`portable-devshell` 为每个启用 MCP 的 instance 暴露一个独立 endpoint：

```text
/<instance>/mcp
```

例如：

```text
http://127.0.0.1:17890/demo-local/mcp
```

MCP 负责把 Control/Worker 能力映射成 Host 可以调用的工具；Context、Workspace、审批、审计和 task 生命周期仍由 portable-devshell 自己维护。

## Endpoint 出现条件

必须同时满足：

1. 全局 `[mcp].enabled = true`；
2. 目标 instance 的 `[mcp].enabled = true`；
3. instance 已经注册到当前 Control。

全局配置只决定 HTTP host：

```toml
# ~/.devshell/control/config.toml
[mcp]
enabled = true
listenHost = "127.0.0.1"
listenPort = 17890
publicBaseUrl = "http://127.0.0.1:17890"
```

认证、Context selector 和工具策略属于各 instance：

```toml
# ~/.devshell/control/instances/demo-local.toml
version = 3
name = "demo-local"
enabled = true
provider = "local"

[mcp]
enabled = true
auth = "none"
contextMode = "explicit"
path = "/demo-local/mcp"

[mcp.tools]
groups = ["file", "bash", "artifact", "tmux", "todo", "workspace"]
capabilities = ["read", "write", "execute"]
```

`path` 由 instance 名生成，当前契约固定为 `/<instance>/mcp`。

## MCP v2 与 2026-07-28

当前 server 基于 MCP TypeScript SDK v2 的 `createMcpHandler`。

2026-07-28 请求按新的 stateless protocol core 服务：不依赖 `initialize`/`initialized` 握手，也不依赖 `Mcp-Session-Id`。portable-devshell 自己的 Context 仍然可以跨请求保持，因为它是应用状态，不是 transport session。

为了兼容尚未迁移的 MCP Host，同一 endpoint 还保留 2025-era Streamable HTTP 的 stateless fallback。旧 client 是否执行 `initialize` 与 portable-devshell Context 是否存在是两件独立的事。

## 长调用 transport

MCP HTTP handler 显式使用：

```text
responseMode = sse
keepAliveMs = 15000
legacy = stateless
```

也就是每个 request-scoped SSE stream 在调用期间持续发送 keepalive comment frame。

这个设计不是为了把工具改成流式输出，而是为了保证**同一个长时间 `tools/call` 可以真实阻塞**，不会因为 HTTP 链路长时间没有 response bytes 而被中间 Host/代理当成 idle connection 关闭。

当前产品把 `tmux_run(wait=block)` 的同步窗口统一设为 **180 秒**：

```text
0s ----------------------------- 180s
       同一个 tools/call 阻塞
       SSE 每 15s keepalive
                                   |
                                   +-- task 未完成 -> durable handoff
```

实测 175 秒调用可以在当前 ChatGPT 链路上完整同步返回；190 秒 task 会在约 180 秒正常返回 `detached: true`，底层 task 继续运行。这里的 180 秒是 portable-devshell 的产品窗口，不是 OpenAI 公布的 MCP hard limit。

详见 [Workspace](workspace.md) 与 [tmux 工具](../tools/tmux.md)。

## Context selector

`[mcp].contextMode` 只决定 MCP 请求如何解析到内部 Context：

### `explicit`

通用 MCP client 默认使用：

* `environ_info` 可以返回 `ctxId`；
* 后续需要 Context 的 model-facing 工具显式携带它；
* server 仍校验 principal 与 Context 生命周期。

### `openai-session`

适用于会给 model-facing tool call 提供稳定 Host metadata 的 ChatGPT 集成：

* model-facing schema 不包含内部 `ctxId`；
* server 从 external binding 找到内部 Context；
* App-only Workspace helper 仍可使用 `ctxId` + 隐藏 capability；
* 如果当前请求没有可解析 binding，调用 fail closed。

`openai-session` 只负责 Context 选择，不负责授权。

完整模型见 [Context](context.md)。

## 认证

每个 instance 独立选择：

```text
none
token
oauth2
```

`none` 只适合受信本地/内网边界；公网 endpoint 应使用 HTTPS 与认证。

`token` 是 portable-devshell 的静态 bearer 模式，适用于支持自定义 bearer token 的通用 MCP client。

`oauth2` 使用 portable-devshell 自带 OAuth resource server/authorization flow；它也是云端 Host 的推荐路径。OAuth v2 路径执行 issuer/resource/scope 校验，具体部署见 [OAuth 与公网暴露](../operations/oauth.md)。

## 工具策略

工具必须同时通过 group 与 capability 两层过滤。

| Group | 主要 model-facing 工具 | 常见 capability |
| --- | --- | --- |
| `environ` | `environ_info` | bootstrap，始终特殊处理 |
| `bash` | `bash_run` | `execute` |
| `file` | `file_read`、`file_edit`、`file_find`、`file_search`、`file_info` | `read` / `write` |
| `artifact` | `artifact_read`、`artifact_viewImage`、`artifact_transfer` | `read` / `write` |
| `tmux` | `tmux_run`、`tmux_input`、`tmux_read`、`tmux_inspect`、`tmux_list`、`tmux_create`、`tmux_close` | `read` / `execute` |
| `todo` | `todo_read`、`todo_write` | 无固定 capability |
| `workspace` | `workspace_open`、`workspace_ask`、`workspace_goal` | 无固定 capability |
| `instance` | `instance_connect` | `manage` |

默认不启用 `instance` group，也不授予 `manage`。

`instance_connect` 是唯一保留在 model-facing MCP catalog 的 instance 管理动作，因为它的语义是“把一个已经存在的 managed instance/workspace 附着到当前 Context”。创建、列出、启动、停止、删除 instance 统一属于 CLI/TUI control plane。

Artifact 分享同样属于 Control 管理面；model-facing `artifact_transfer` 负责 Context 内的跨实例传输，而公开 share 的创建/撤销使用 `devshell artifact ...`。

## Workspace App 工具边界

模型可以看到的 Workspace 工具保持很小：

```text
workspace_open
workspace_ask
workspace_goal
```

其中 `workspace_open` 只是重新呈现/恢复入口；正常 bootstrap 已由 `environ_info` 完成。

`workspace_snapshot`、`workspace_watch`、`workspace_reconnect`、`workspace_answer`、`workspace_interrupt`、`workspace_approval`、re-entry control 等属于 App-only wire 协议。它们可以存在于 endpoint 内部，但不应出现在模型工具列表或文档的 Agent 使用示例中。

详见 [Workspace](workspace.md)。

## Skills、Project memory 与环境信息

`environ_info` 返回当前 worker 上的 canonical workspace、platform、skills directory、temporary directory，以及存在时的 project memory 路径。

Worker handshake 本身只提供通用的 `homeDirectory + platform`；MCP builtin module 通过通用 Worker Resource Host 准备 `skill/managed` collection，并把返回目录作为 `skillsDirectory`。Worker handshake 不理解 Skill。

本机 `devshell skill` catalog 的发现优先级是：

```text
project  <workspace>/.agents/skills
managed  ~/.devshell/skill
global   $XDG_CONFIG_HOME/agents/skills
```

`skill list/search` 只加载轻量 metadata；`skill load/inspect` 才加载完整 `SKILL.md`，`skill read` 按需读取附属文件。需要把某项 Skill 安装到目标 Worker 时显式执行 `skill get <name> <instance>`；Skill Extension 对选中目录做内容快照，通过 Worker Resource Host 取得 instance-scoped `skill/managed` collection，再由 Artifact 基础设施原子传输到该 collection 的 `<name>` entry。

Skill 不再绑定 provider 生命周期。local、SSH、Docker、Podman 和 self-managed Reverse 都使用同一条 Extension assets + Worker control + Artifact transfer 路径。

## 请求取消

MCP v2 的 per-request HTTP stream cancellation 会传播成当前 request 的 AbortSignal；2025-era client 还可能通过旧 cancellation 机制触发取消。

工具按自身安全点处理：

```text
排队 / 等待审批    立即取消
bash_run           终止对应进程组
file read/search   在读取/扫描安全点停止
file_edit          已完成的原子子操作不回滚
artifact read      停止读取并释放 lease
tmux_run           只停止当前等待；已启动 task 继续运行
tmux_read          停止等待；尚未返回的 transcript 不被消费
```

取消不是事务回滚协议。

## 旧 recipient 兼容

已经被 Host 缓存的旧工具名不会重新进入 `tools/list`。

server 对一小部分历史 recipient 保留隐藏兼容：能安全等价转换的会路由到当前动作；已经迁到 CLI 的工具返回结构化 stale-tool 提示。新 Agent 不应该依赖这些名字。

## 手动验证

最可靠的验证方式是使用真实 MCP client 或项目 integration tests，因为 2026-07-28 与 2025-era 请求形状不同。

HTTP 层可以先确认 endpoint 存活：

```bash
curl -i -N http://127.0.0.1:17890/demo-local/mcp \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"req-init","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"manual-check","version":"0.0.0"}}}'
```

旧兼容路径的成功响应可能是 SSE `event: message`，不要假设响应一定可以直接 `response.json()`，也不要把 `Mcp-Session-Id` 当成 portable-devshell Context。

## 本地与公网

Control 不根据 `listenHost` / `publicBaseUrl` 推断防火墙和网络信任边界。

* 本机测试可以使用 loopback + `auth = "none"`；
* 公网 endpoint 应使用 HTTPS；
* `publicBaseUrl` 必须与外部实际 URL 一致，尤其是 OAuth metadata、callback 和 Workspace App origin；
* 反向代理必须允许长时间 SSE response，不应缓存 MCP/OAuth 响应。

部署说明见 [OAuth](../operations/oauth.md) 和 [ChatGPT 公网隧道](../operations/chatgpt-tunnels.md)。
