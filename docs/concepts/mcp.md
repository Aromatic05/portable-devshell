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

全局配置管理 HTTP host 与 OAuth 审批模式/token；endpoint 的 auth 由 instance 选择。Control 持有真实 TCP listener，MCP 取得可撤销 lease，不拥有 listener：

```toml
# ~/.devshell/control/config.toml
[mcp]
enabled = true
listenHost = "127.0.0.1"
listenPort = 17890
publicBaseUrl = "http://127.0.0.1:17890"
```

认证、Context selector 和 model Extension ACL 属于各 instance：

```toml
# ~/.devshell/control/instances/demo-local.toml
version = 4
name = "demo-local"
enabled = true
provider = "local"

[mcp]
enabled = true
auth = "none"
contextMode = "openai-session"
path = "/demo-local/mcp"

[extensions]
model = ["artifact", "comment", "instance", "mcp", "recall", "secret", "skill"]
```

这是 version 4 fresh defaults 对 Context selector / model Extension ACL 的示例；需要模型显式携带 `ctxId` 的通用 Host 应改用 `contextMode = "explicit"`。MCP `tools/list` 本身合并 Worker、Control primitive 与 Extension `mcp.tools` 声明，不由 `[extensions].model` 裁剪。

`path` 由 instance 名生成，当前契约固定为 `/<instance>/mcp`。

## MCP v2 与 2026-07-28

当前 server 基于 MCP TypeScript SDK v2 的 `createMcpHandler`。

2026-07-28 请求按新的 stateless protocol core 服务：不依赖 `initialize`/`initialized` 握手，也不依赖 `Mcp-Session-Id`。portable-devshell 自己的 Context 仍然可以跨请求保持，因为它是应用状态，不是 transport session。

当前两个 HTTP handler 均设置 `legacy = "reject"`：2025-era legacy 协议路径不被接受。Context 持续性不能用作旧协议兼容的依据。

## 长调用 transport

MCP 按请求选择两个共享 event bus 的 handler：

| 请求 | responseMode | keepAliveMs | legacy |
| --- | --- | --- | --- |
| `tools/call`，但工具不是 `environ_info` | `sse` | `1000` | `reject` |
| 其他请求（含 `environ_info`） | `auto` | `15000` | `reject` |

长调用的 request-scoped SSE 在调用期间持续发送 keepalive comment frame；auto handler 不意味着每个响应都是 SSE。

这个设计不是为了把工具改成流式输出，而是为了保证**同一个长时间 `tools/call` 可以真实阻塞**，不会因为 HTTP 链路长时间没有 response bytes 而被中间 Host/代理当成 idle connection 关闭。

当前产品把 `tmux_run(wait=block)` 的同步窗口统一设为 **180 秒**：

```text
0s ----------------------------- 180s
       同一个 tools/call 阻塞
       SSE 每 1s keepalive
                                   |
                                   +-- task 未完成 -> durable handoff
```

历史链路实验曾观察到 175 秒调用同步返回、190 秒 task 在约 180 秒返回 `detached: true`；这些是当时环境的观测，本次文档修订未重跑。当前实现的同步窗口仍是 180 秒，handoff 后底层 task 继续运行。这里的 180 秒是 portable-devshell 的产品窗口，不是 OpenAI 公布的 MCP hard limit。

详见 [Workspace](workspace.md) 与 [tmux 工具](../tools/tmux.md)。

## Context selector

`[mcp].contextMode` 只决定 MCP 请求如何解析到内部 Context：

### `explicit`

通用 MCP client 应显式配置此模式（fresh instance 产品默认仍为 `openai-session`）：

- `environ_info` 可以返回 `ctxId`；
- 后续需要 Context 的 model-facing 工具显式携带它；
- server 仍校验 principal 与 Context 生命周期。

### `openai-session`

适用于会给 model-facing tool call 提供稳定 Host metadata 的 ChatGPT 集成：

- model-facing schema 不包含内部 `ctxId`；
- server 从 external binding 找到内部 Context；
- App-only Workspace helper 仍可使用 `ctxId` + 隐藏 capability；
- 如果当前请求没有可解析 binding，调用 fail closed。

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

## MCP catalog、Extension contribution 与 command ACL

MCP endpoint 不再用 instance 配置中的 group/capability 去动态裁剪 `tools/list`。Control 合并固定的 protocol/runtime primitive、当前 Worker tool schema 和 Extension `mcp.tools` 静态声明。Extension contribution 的安装、移除或声明变化会同步增删 catalog 和 executor；`[extensions].model` 则只授权 shell model command，不能代替 MCP tool contribution 的生命周期或执行检查。

主要边界是：

| Domain            | MCP model-facing surface                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Environment       | `environ_info`、`environ_remote`                                                               |
| Worker shell/file | `bash_run`、`file_read`、`file_edit`、`file_glob`、`file_grep` 等 Worker primitive             |
| Artifact          | Control `artifact_viewImage`；Worker 不暴露独立 Artifact 读取工具                              |
| tmux              | `tmux_run`、`tmux_input`、`tmux_read`、`tmux_inspect`、`tmux_manage`                           |
| Goal              | `workspace_goal`（最终目标管理）                                                      |
| Comment           | Comment `mcp.tools` 提供 `progress_report`（面向用户的进度报告）                        |
| Workspace         | `mcpapp_open` 重新呈现入口；`mcpapp_action` / `mcpapp_reentry` 为 App-only                       |
| Instance          | 无固定 MCP 管理 tool；model Extension 只负责 discovery/status/logs 与 opaque handle projection |

Worker catalog 的 description 只描述 canonical capability 契约；MCP endpoint 在暴露 Worker tool 时独立投影面向 ChatGPT/MCP consumer 的使用说明。这个投影不回写 Worker，也不与 Agent Extension 的 model description 共用实现。

跨 instance bootstrap 分成两步：model-facing `devshell instance list/status` 只读取当前 Context
可见的 managed instance，并为非 primary instance 返回 opaque handle；随后固定 MCP
`environ_remote` 使用该 handle 修改 Context environment。它采用稳定的开放 command envelope，
当前命令为 `help`、`attach`、`mask`，command 不写进 JSON Schema enum，因此以后增加子命令不要求
刷新 tool schema。`mask` 对当前 Context 不可撤销，并从 model discovery 与所有 routed tool 中屏蔽
对应 instance。创建、启动、停止、删除等 owner 管理仍由原生 `devshell instance ...` / TUI 负责。

可扩展命令走另一条数据面。`bash_run` / `tmux_run` 启动的进程环境中存在 Context-bound `devshell` shim；它只解析 `cli.model-commands`，并按当前 instance 的 `[extensions].model` allowlist 授权。例如：

```toml
[extensions]
model = ["instance", "artifact"]
```

当前 bundled 默认是 `artifact / comment / instance / mcp / recall / secret / skill`；独立安装的 Extension（例如 `agent`）需要显式加入。`environ_info` 会报告当前 Context 实际可用的 model `devshell` root，并提示使用 `devshell --help` / `devshell <command> --help`。model command 找不到或不在 ACL 中时不会 fallback 到原生 builtin CLI。

Artifact 分享与跨实例传输属于 Artifact Extension command，不再是 MCP tool。人类本地使用 `devshell artifact ...`；模型只有在 `artifact` 被当前 instance 的 model Extension ACL 允许时，才能通过 shell/tmux 中的 `devshell artifact ...` 调用。

## Workspace App 工具边界

模型侧正常调用 `environ_info` 完成 Context 与 Workspace bootstrap。启用 Workspace 后，`mcpapp_open` 仅用于显式重新呈现/恢复界面，并不是每次工具调用的前置步骤。独立 Ask/Question Store 和 `workspace_ask` / `mcpapp_ask` 已退役，不是当前模型工具。

App 通过带隐藏 capability 的 Live Workspace route 读取 `snapshot` / `watch`；修改 Approval 和 Goal 人工控制状态使用 app-only `mcpapp_action`，自动模型恢复使用 app-only `mcpapp_reentry`。这些写入仍由 ToolCall Pipeline 验证和审计，不允许普通模型直接调用，也不会将领域内部的 Goal/Wait DTO 交给 UI 自行修改。Inline ToolCall/Interaction 与 Fullscreen Workspace 使用不同的 presentation resource。

详见 [Workspace](workspace.md)。

## Skills、Project memory 与环境信息

`environ_info` 使用紧凑 `comment` 提示报告当前 Workspace、临时目录、Skills 和 Memory 的必要信息；Memory 的 `init` / `inherit` 指引由 Comment Extension 提供，不另建结构化 Memory 状态字段。

Worker handshake 本身只提供通用的 `homeDirectory + platform`；MCP builtin module 通过通用 Worker Resource Host 准备 `skill/managed` collection；当前 `environ_info` 不返回 `skillsDirectory` 字段。Worker handshake 不理解 Skill。

Skill 的 native 命令读取 Control-host catalog；Context-bound model 命令通过 Worker session 读取当前 workspace 的 project Skills，再合并 Control-host managed/global catalog。native catalog 的发现优先级是：

```text
project  <workspace>/.agents/skills
managed  ~/.devshell/skill
global   $XDG_CONFIG_HOME/agents/skills
```

`skill list/search` 只加载轻量 metadata；`skill load/inspect` 才加载完整 `SKILL.md`，`skill read` 按需读取附属文件。需要把某项 Skill 安装到目标 Worker 时显式执行 `skill get <name> <instance>`；Skill Extension 对选中目录做内容快照，通过 Worker Resource Host 取得 instance-scoped `skill/managed` collection，再由 Artifact 基础设施原子传输到该 collection 的 `<name>` entry。

Skill 不再绑定 provider 生命周期。local、SSH、Docker、Podman 和 self-managed Reverse 都使用同一条 Extension assets + Worker control + Artifact transfer 路径。

## 请求取消

MCP v2 的 per-request HTTP stream cancellation 会传播成当前 request 的 AbortSignal；当前 endpoint 拒绝 legacy 协议路径。

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

使用支持 2026-07-28 的真实 MCP client 读取 `tools/list`，再按该 endpoint 实际 schema 调用 `environ_info`。OAuth endpoint 应先完成认证；通用 client 应显式配置 `contextMode = "explicit"`。

网络层可单独验证 OAuth discovery/challenge，见 [OAuth](../operations/oauth.md)。旧 `initialize(protocolVersion=2025-11-25)` 请求属于 legacy 负向检查，应被拒绝，不能作为当前 endpoint 成功验证。不要把 `Mcp-Session-Id` 当作 portable-devshell Context。

## 本地与公网

Control 不根据 `listenHost` / `publicBaseUrl` 推断防火墙和网络信任边界。

- 本机测试可以使用 loopback + `auth = "none"`；
- 公网 endpoint 应使用 HTTPS；
- `publicBaseUrl` 必须与外部实际 URL 一致，尤其是 OAuth metadata、callback 和 Workspace App origin；
- 反向代理必须允许长时间 SSE response，不应缓存 MCP/OAuth 响应。

部署说明见 [OAuth](../operations/oauth.md) 和 [ChatGPT 公网隧道](../operations/chatgpt-tunnels.md)。
