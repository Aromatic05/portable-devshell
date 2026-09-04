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
artifactDirectTransfer = false
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
contextMode = "explicit"
path = "/demo-local/mcp"

[mcp.tools]
groups = ["file", "bash", "artifact", "tmux", "todo", "workspace"]
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

`[mcp].contextMode` 决定环境 Context 的外部 selector：

- `explicit`（默认）：`environ_info` 返回 `ctxId`，后续工具显式携带 `ctxId`。适用于任意 MCP client。
- `openai-session`：仅用于会在每次 tool call 的 `_meta["openai/session"]` 中提供 ChatGPT session 标识的 Host。`environ_info` 不向模型返回 `ctxId`，后续工具 schema 也不包含 `ctxId`；服务端使用 `openai/session` 选择内部 Context。该值只用于 Context 选择，不用于授权。

两种模式最终都解析到同一个内部 `ctxId`。`ctxId` 是 portable-devshell 的 canonical runtime key，Todo、Wait、Approval、Comments、audit 与 instance/workspace attachment 始终只依赖它；外部 selector 仅存在于 MCP 边界。实现通过 `McpContextSelector` 接口把请求携带的外部身份解析到内部 Context，因此未来接入其他 Host 时不需要给这些子系统增加平台专用 ID 字段。MCP transport 的 `mcp-session-id` 与 Context selector 继续保持独立。

如果 endpoint 配置为 `openai-session`，但 client 没有提供 `openai/session`，调用会 fail closed；不会退回 MCP transport session，也不会自动切换成 explicit 模式。

`openai-session` 只能配合 `auth = "none"` 或 `auth = "oauth2"`。portable-devshell 的静态 `auth = "token"` 仍可供通用 MCP client 使用，但 ChatGPT 不支持把自定义 API key / 静态 bearer secret 作为插件认证方式，因此该组合在配置校验阶段直接拒绝。

## 工具组与能力

工具是否出现，需要同时满足所属 group 已启用、所需 capability 已授予。

| Group      | 主要工具                                                                                 | 常见 capability   |
| ---------- | ---------------------------------------------------------------------------------------- | ----------------- |
| `bash`     | `bash_run`                                                                               | `execute`         |
| `file`     | `file_read`、`file_edit`、`file_find`、`file_search`、`file_info`          | `read`、`write`   |
| `artifact` | `artifact_read`、`artifact_viewImage`、`artifact_share`、`artifact_transfer`             | `read`、`write`   |
| `tmux`     | `tmux_run`、`tmux_input`、`tmux_read`、`tmux_inspect`、`tmux_list`、`tmux_create`、`tmux_close` | `read`、`execute` |
| `todo`     | `todo_read`、`todo_write`                                                                | 无硬性 capability |
| `workspace` | `workspace_open`、`workspace_ask`、`workspace_goal`；另含仅 Workspace App 可调用的内部 helper | 无硬性 capability |
| `instance` | `instance_list`、`instance_status`、`instance_create`、`instance_connect`、`instance_stop` | `manage`          |

默认不包含 `instance` group，也不授予 `manage`。`instance_connect` 是幂等的“确保可用”入口：目标未启动时由 Control 启动并连接，已经 ready 时不重复启动；可选 `workspace` 会作为当前 `ctxId` 在该 instance 上的 workspace attachment。`selfManaged` reverse worker 不由 Control 启动，`instance_connect` 只接受已经连入的 worker。`instance_stop` 仍只适用于由 Control 管理生命周期的 worker。用户从 TUI 定向发送给某个 Context 的 Comment 不作为独立 MCP 工具暴露；消息按 `ctxId` 排队，并附着到该 Context 下一次成功的普通工具结果中。

MCP 对已经被 ChatGPT 缓存的旧 recipient 保留一层隐藏兼容。兼容名字永远不重新出现在 `tools/list`：语义仍是当前操作安全超集的 `instance_start` 会透明路由到 `instance_connect`，并继续接受当前 group / capability / Context 校验；无法安全等价转换的 `context_message_read`、`file_write`、`tmux_send`、`tmux_capture`、`tmux_reclaim` 不执行旧操作，而是返回结构化 `staleToolSnapshot`，说明移除版本和当前迁移方式。未知且从未受支持的工具名仍按普通 not-exposed 错误处理。

## Workspace MCP App 与人工交互

`environ_info` 是正常调用链上唯一的 Context / Workspace bootstrap：它在准备 workspace 环境的同时签发隐藏的 Workspace App capability，并通过同一个 tool result 呈现 Live Workspace。模型不再需要先调用 `workspace_open`。`workspace_open` 仅保留为显式重新呈现/恢复入口，例如用户关闭了 App、iframe remount 后需要重新挂载，或 `workspace_ask` / `workspace_goal start` 明确报告 App 已失活。App 视图附着在产生它的 tool result / 对话消息上，并不是跨后续消息常驻的独立 ChatGPT 面板；Context、durable Wait、Goal、Todo 等服务端 Workspace 状态继续存在。MCP 边界先用当前 selector 得到内部 Context，再返回该 Context 的 authoritative snapshot；在 `explicit` 模式中 App 需要携带 `ctxId`，在 Host-managed selector 模式中 App 不接触 `ctxId`，后续 app tool call 由 Host metadata 重新解析到同一内部 Context。可见 UI 固定按“需要用户处理的事件 → 当前 Goal → 后台等待”排列。`currentEvent` 只允许 Question 与 Approval，waiting/detached 的 tmux Wait 永远属于后台状态，不会抢占人工操作。相同优先级的人工事件按最早待处理者优先；detached Question 低于仍有原始 held call 的 waiting Question。

Workspace 的 Host 协议由官方 `@modelcontextprotocol/ext-apps` `App` 实现，portable-devshell 不再自行维护 postMessage JSON-RPC bridge。实际 render URI 根据完整 HTML 内容生成 hash，例如 `ui://portable-devshell/workspace-<hash>.html`，因此 ChatGPT 的 template/render cache 会在内容变化时获得新的 cache key。`ui://portable-devshell/workspace/v1.html` 只作为稳定 reader alias 保留；已经发布过的历史 hash URI也必须继续作为隐藏 alias 可读，不能让旧会话因升级失去模板。

Workspace 内部使用 app-only 的 `workspace_reconnect`、`workspace_snapshot` 和 `workspace_watch` 保持 live state；这些 helper 不应由模型主动调用。App 首次挂载通常读取 `workspace_snapshot`，发生 iframe remount 或 Host/transport reconnect 时先调用 `workspace_reconnect` 重新建立 App 生命周期，再读取 authoritative snapshot；`workspace_watch` 复用 instance 现有的 event sequence cursor，只在当前 Context 的 `toolCall.*`、`approval.*`、`todo.*`、`wait.*` 事件发生时返回新 snapshot。事件历史出现 gap 或 Control 重启导致 cursor 失效时，直接重新读取 authoritative snapshot。正常无变化时只返回 heartbeat，不使用固定频率 snapshot polling。Question 只默认展示前三个选项，其余折叠；Approval 同时展示风险级别、动作摘要和审批原因；Goal 只展示总体进度与当前/下一步，blocked 时展示原因并提供 app-only `workspace_resume`，completed/stopped 后自动收起。没有 Goal、task、Question、Approval 或后台等待时显示明确的 `Workspace / Ready` 空状态卡片，避免把“当前没有任务”表现成白屏。

iframe remount 或 MCP/Control 重启后，读路径会重新通过当前 selector 解析内部 Context，并从 snapshot metadata 获得新的 app token；旧 token 不需要持久化。`explicit` 模式把 `ctxId` 放进 `window.openai.widgetState` 作为 remount hint；Host-managed selector 模式只记录“无需显式 ctxId”这一能力位，不把内部 ctxId 暴露给 iframe。ChatGPT remount 时只有存在 `toolResponseMetadata.mcp_tool_result` / `call_tool_result` envelope 时才接受 `window.openai.toolOutput` 覆盖其中可能缓存的旧 structured output，不能把一个孤立的全局 `toolOutput` 当成 Workspace 身份来源。App 在 connect 后短暂等待真实 initial tool result，再回退到 widget state。`workspace_answer`、`workspace_interrupt`、`workspace_resume`、`workspace_stop` 和 `workspace_approval` 属于人工写操作，仍必须携带当前隐藏 app token；服务端最终仍以解析得到的内部 `ctxId` 校验目标对象归属。当前 ToolDefinition 名称统一遵循单一 `namespace_operation` 分隔符；v0.6.15 已挂载 iframe 使用过的多段 app-only 名只在隐藏 wire compatibility decoder 中接受，用于跨 MCP/Control 热升级，不进入 catalog、`tools/list` 或新的调用契约。

`workspace_ask` 用于模型确实需要人类输入时挂起当前调用，不要求 Todo 或 Goal。服务端会优先把 Question 关联到当前 active/blocked Goal，其次关联当前唯一的 `in_progress` Todo；两者都没有时仍可建立只归属于 Context 的 durable Wait。新的 held call 只允许在 Workspace App 最近仍活跃时建立：`environ_info` 在初始 bootstrap 时签发 Workspace 视图；显式 `workspace_open` 复用同一机制用于重新呈现。App 实际调用 `workspace_snapshot` / `workspace_watch` 后建立 60 秒 liveness lease；lease 过期后 `workspace_ask` fail fast，避免在 iframe 已经消失时制造无人能回答的阻塞调用。Host 取消原 tool call 时等待会变成 detached。MCP/Control 进程重建时，持久化为 `waiting` 的 Wait 会统一按 orphaned owner call 恢复成 detached，因此旧 Question 不会假装仍有可返回的 tool call，用户之后回答时可以走 model re-entry 恢复。

Todo task 现在同时承担 model re-entry checkpoint。模型在 `todo_write` 更新计划时可以写 `checkpoint.summary`，并可附带 `next` 与 `blockers`；checkpoint 与 taskId 一起持久化，后续 Workspace snapshot 会把它投影给 Host。Workspace 每次拿到 authoritative snapshot 后使用 MCP Apps 的 `ui/update-model-context` 覆盖该 View 的模型上下文；这个操作不会主动触发新的模型回合。

Todo runtime 仍保留 task-level Pause / Resume / Cancel 语义，用于 durable task 生命周期和兼容已经挂载的旧 Workspace App；当前紧凑 Workspace 不再把 task controls 作为常驻面板展示。它们不会隐式向 tmux 进程发送信号。

`tmux_run` 使用与 `workspace_ask` 相同的关联规则建立 durable Wait。`wait: block` 会先以 managed task 启动命令并立即建立 Wait，因此 Workspace 从等待开始就可以让用户选择 `Stop waiting`。MCP 只在当前 Host tool call 的安全窗口内挂住模型，固定最多 3 分钟；任务在此期间结束则直接返回结果。任务仍在运行时转成 detached，由 Workspace 接管后续恢复。`timeout` 从任务启动开始计算；detached 后，任务结束或该绝对截止时间先到达，都会解析 durable Wait 并通过 Workspace 恢复模型。失败退出码同样会解析 Wait。允许更大的 `timeout` 不代表单次 Host tool call 会同步阻塞同样长的时间。整个过程只保留一条逻辑 `tmux_run` ToolCall；MCP 为了 handoff 而执行的 nonblock 启动、task observation 和 transcript consume 都属于该调用的内部子操作，不再另外写 ToolCall history。

用户在 Workspace 选择 `Stop waiting` 时，Wait 会解析为 `interrupted` 结果，但绝不会停止对应 tmux task。若原始 `tmux_run` tool call 仍处于同步 block 阶段，该调用立即返回 `interrupted: true`，模型在当前 turn 继续；若已经进入 detached 阶段，Workspace 停止后台 observer，并通过与正常完成相同的 durable recovery claim/send/complete 流程立即重新进入模型。两种情况都只结束等待，不结束 task。

detached wait 在任务完成、`tmux_read` 等待到新 output、timeout 或用户 `Stop waiting` 后都会进入 resolved，再由 App 对仍可恢复的 wait 做短租约 claim：关联 Goal 时要求 Goal 仍 active/blocked，关联 Todo 时要求 task 未 paused，没有 Goal/Todo 关联时按当前 Context 直接恢复。App 先用 `ui/update-model-context` 写入当前状态，再用带持久化 `recoveryMessageId` 的 `ui/message` 恢复模型；消息成功后先记录 sent marker，再 complete/consume 该 Wait，消息发送失败则 release claim 让后续 remount 重试。一个 `tmux_read` detached wait 因 output ready 解析时应产生一次模型恢复消息，但“transcript 当前仍有 unread 内容”本身不会凭空建立新的 Wait 或发送消息。同一 Context、目标 instance 和 tmux task 同时最多保留一个尚未完成恢复的 tmux Wait，旧状态里若存在重复记录会先收敛后再恢复。并发 App 也不能同时 claim 同一个 Wait。普通 live activity 和仍存活的 Question 回答不会触发额外 `ui/message`。

## Skills 与项目记忆提示

Control 机器上的 Skill 目录固定为：

```text
~/.devshell/skill
```

- local instance 直接使用同一台机器上的目录，不进行复制；
- SSH、Docker 和 Podman instance 在启动或重新连接 worker 时，将该目录镜像到 worker 用户的 `~/.devshell/skill`；
- self-managed reverse instance 由 worker 所在机器自行维护该目录，Control 不主动推送。

`environ_info` 接收 `workspace` 参数；它是 **worker 机器上的绝对目录**，由调用方在自己已获准访问的目录范围内选择。返回的 structured content 包含 canonical workspace、worker 上展开后的绝对 `skillsDirectory`，并提示 Agent 按需读取其中相关 Skill 的 `SKILL.md`；同一个结果的隐藏 metadata 同时携带 Workspace App capability 与 render template，因此环境准备与 Live Workspace bootstrap 不再需要两个模型工具调用。

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
tmux_run           block 等待超出固定 3 分钟后分离；task 继续运行，Workspace 在任务结束或绝对 timeout 到达时恢复模型
```

worker handshake 返回 `cancel = true`。本地 RPC、WSS 和 SSE + HTTPS POST 反向连接都允许取消请求在长工具运行期间到达 worker。工具调用历史使用 `cancelled`，等待审批时还会产生 `approval.cancelled`。

## 本地与公网

- `mode = "none"`、`token` 和 `oauth2` 均可用于本机、内网或公网监听；
- control 不根据 `listenHost` 或 `publicBaseUrl` 猜测防火墙、反向代理和网络信任边界；
- 无认证 endpoint 的访问控制与暴露范围由部署者负责；
- 给 ChatGPT Connector 使用时，必须通过公网 HTTPS 地址访问，并按客户端要求配置认证。

公网配置见 [oauth.md](oauth.md)。
