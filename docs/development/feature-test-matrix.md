# Portable-DevShell 1.0 Beta 功能与测试矩阵

> 范围：`1.0.0-beta.1`；基线为现有用户决策、代码注册入口和可执行测试，不以历史设计稿反推已退役功能。
>
> 本文记录**应提供什么功能**以及**什么测试能证明它可用**。`代码已有`、`有测试文件`、`测试已运行`、`真实 Host/平台验收通过` 是四个不同判断。没有证据时保持“待验证”，不能把存在的 mock/unit test 写成真正的 E2E。
>
> 更新规则：新增工具/Route/Extension Point/Extension/持久化格式时增加对应功能行和证据；所有权改变或功能退役时以用户最近一次明确决策为准。具体测试命令以 [acceptance](acceptance.md)、[testspace](testspace.md) 为准。

## 1. 主体链路

```text
Human (CLI / TUI / Web)       MCP Host (ChatGPT / SDK)
           │                           │
           └────────┬──────────────────┘
                    ▼
           Control & MCP Host
  Auth / OAuth2 / OIDC / Context selector
  Instance Registry / Config / Extension Host
                    │
                    ▼
         unified ToolCall ingress
    inbound rewrite / review / Approval
         Scheduler → Execute Handler
         Worker RPC | Control operation
    outbound rewrite / review / Audit
                    │
         ┌──────────┴───────────┐
         ▼                      ▼
  Provider Transport       Host-owned Operation
 Local / SSH / Container   Context / Todo / Approval
 Reverse WSS/SSE           Artifact / Extension
         │                      │
         ▼                      │
  Rust devshell-worker           │
  Bash / File / Tmux / Artifact  │
         └──────────┬───────────┘
                    ▼
       Result / Events / Audit / Message
                    │
          MCP App / Web / TUI
       Fullscreen + Inline + Activity
```

Workspace、Todo/Goal、Comment/Memory 和 Extension 是跨层能力，**不是所有 ToolCall 必经的顺序节点**。MCP Server、MCP Client Extension、MCP App 是三个独立功能组。

| 链路 ID | 可执行主体链路 | 正常链必须证明 | 失败 / 恢复 / 并发必须证明 | 当前验收入口 |
|---|---|---|---|---|
| L01 | Installer → CLI Init → Control → Instance → Worker Ready | 安装、启动、握手、工具发现 | 原版本回滚、缺失 Worker、Config/DB 迁移、旧状态保留 | `acceptance:worker`、`testspace upgrade-smoke`、install scripts |
| L02 | Host → Auth → Context → Pipeline → Execute → Audit → Host | 真正 MCP `tools/call`、结果、审计 | 取消、Approval、Hook 改写、故障隔离、同 Call 不重复 Execute | `acceptance:mcp`、`mcp/Worker.test.ts`、`core/Pipeline.test.ts` |
| L03 | CLI/TUI/Web → Control RPC → Mutate → Commit → Event → Refresh | 三端读取和修改同一权威状态 | 并发 Revision、断线重连、失败提交无半状态 | Web Chromium、TUI tests、Control RPC tests |
| L04 | Reverse Create → Device Code → Enroll → WSS/SSE → Worker | 注册、连接、调用工具 | Code 过期/重发、Token 轮换/撤销、断线、Generation 竞态 | `worker/Reverse.test.ts`、`ReverseConnectionGateway.test.ts` |
| L05 | Context → Goal/Todo → Wait → MCP App Action → Reentry | Pause/Resume、Wait handoff、恢复上下文 | 原 HTTP 断连、remount、幂等 Receipt、模型已忙、Host 投递不确定 | `testspace workflow-smoke`、`McpAppLive.test.ts`、`mcpapp/App.test.tsx` |
| L06 | Extension Install → Manifest → Generation → Sandbox → Point/Capability → Reload | 发现、授权、调用、热替换 | 坏候选保留旧版、流订阅关闭、旧 Generation 资源回收 | Control Extension tests、显式 `testspace extension-smoke` |
| L07 | Worker Payload → Artifact Store → Lease → Share/Transfer → Revoke/GC | 图片、文件、目录、Range、传输 | TTL、引用计数、断线、中断恢复、分片回滚、目标冲突 | `ArtifactHttpRoute.test.ts`、`artifact` tests |
| L08 | Package → Upgrade → Migration → Restart → Verify/Rollback | 配置/SQLite Schema 升级后恢复使用 | 中途失败回滚、旧数据、过旧格式预检查与不相关业务继续运行 | `testspace upgrade-smoke`、Migration/Installer tests |

## 2. 测试证据与状态语义

- **U — 契约/单元**：本地隔离测试，可用 fake，但只证明对应局部语义。
- **I — 集成**：多个真实 domain / SQLite / HTTP / Worker 协作；依赖仍需逐项说明。
- **E — E2E/Testspace**：真实发行包或运行时、Control/Worker/CLI/MCP 的闭环。
- **H — Host 手工验收**：真实 ChatGPT / 外部 OAuth Provider / 人机交互行为；mock `sendMessage` 不算。
- **P — Platform**：目标 OS/CPU 的真实运行行为；交叉编译成功不算运行验收。
- **R — 压力/恢复**：弱网、并发、数据量、重启、资源泄漏、重复操作。

下列“证据”列出**现有入口/候选入口**，不宣称当次已经运行。完整回归后应在执行记录中写 commit、命令、退出码、平台及真实/模拟依赖，不在本文硬编码一次性的“全绿”。

## 3. 核心功能组与子功能

| ID | 功能组 | 必测子功能（分别断言，不以一个 Happy Path 代替） | 现有证据入口 | 应补充的组合 / 平台证据 |
|---|---|---|---|---|
| C01 | Control/Daemon | Start、Shutdown、Restart、Hello、Status、Owner Lock、异常回收 | `control/server`、`Control.test.ts` | 异常退出后重新启动；历史清理债务不阻塞服务 |
| C02 | Config/Store | TOML Parse/Validate、Batch Update、Revision、事务、Secrets Redaction、热更新、Migration | `control/config`、`testspace update-smoke` | Web/MCP 共享 Listener 替换失败；部分写失败隔离 |
| C03 | Instance Lifecycle | Create、Enable/Disable、Start/Stop、Delete/Recreate、Cleanup Debt、retry、Worker Rebuild | `InstanceLifecycle.test.ts`、`InstanceDeleteRecovery.test.ts` | 删除时在途 ToolCall/Stream；同名复用不被清理债务无故阻断 |
| C04 | Provider | Local、SSH、Docker、Podman、Reverse；安装、Handshake、Status、Logs | `control/provider`、`cli/instance`、Worker acceptance | SSH 真机；容器 Preset/Image/Adopt/Dockerfile/Compose 逐分支 |
| C05 | Reverse Enrollment | Device Code 创建/失效/消费、Enroll、Token Rotate/Revoke、WSS/SSE、Generation | `ReverseConnectionGateway.test.ts`、`worker/Reverse.test.ts` | 断线期间重试；弱网；失败 Enrollment 明确告知，不能假成功 |
| C06 | Transport | Frame、Envelope、RPC/Event/Stream、Route、Multiplex、Cancel、Gap、Replay、Backpressure | `shared/transport`、`StreamRecovery` | 乱序/重复/截断、载荷预算、断线恢复压力 |
| C07 | ToolCall Pipeline | Inbound Rewrite/Review、Approval、Scheduler、Execute Handler、Outbound Rewrite/Review、Audit Commit | `core/tool/Pipeline.test.ts`、`control/toolcall` | Extension Hot Reload 中在途 Call、拒绝不二次 Execute、Result/Error/Progress 一致 |
| C08 | Security & Approval | Workspace/Disabled、Policy、Ask/Approve/Deny、Remember、Reason、Context/Secret Scope | `core/approval`、`testspace approval-smoke` | 多入口争抢决策、审批撤销/过期、取消与继续操作隔离 |
| C09 | Context | Explicit/OpenAI Session、Principal、Lease、Renew/Disable、Env Attach/Mask、Memory Comment | `control/context`、`testspace model smoke` | 失去外部 Host binding、切 Workspace 在途 Goal/Wait、mask 不可逆 |
| C10 | OAuth2 | Authorization Code、PKCE、动态 Client Registration、Scope/Audience、Refresh/Revoke、Resource Metadata、授权审批 | `mcp/OAuth.test.ts`、`DynamicOAuth.test.ts` | 公网域名/代理、实际 ChatGPT OAuth Client、刷新/撤销后的现有连接 |
| C11 | MCP Server | None/Token/OAuth、`tools/list`/`tools/call`、Context Binding、Schema、SSE Keepalive、旧协议兼容 | `mcp/Http.test.ts`、`mcp/Worker.test.ts`、`acceptance:mcp` | 真 Host 180s handoff、网络断连、多个 Instance Endpoint 同 Listener |
| C12 | MCP Client Extension | Profile、Server Discovery、Tool List/Call、超时/取消、Context ACL | `extensions/mcp/test` | 外部 Server、跨 Context 的配置和权限生命周期 |
| C13 | MCP App | Fullscreen Workspace、Inline Approval/Wait/ToolCall、Action Receipt、Activity、Remount、Reentry | `mcpapp/App.test.tsx`、`McpAppLive.test.ts`、`testspace workflow-smoke` | 真 ChatGPT Host、卡片长期保留、点击交互、真实 `sendMessage`；已退役独立 Ask |
| C14 | Goal/Todo/Wait | Goal 创建/管理/推进、Todo Revision/Checkpoint、Wait Handoff/Cancel/Resume、Reentry Ownership | `core/task`、`testspace workflow-smoke`、`testspace long-smoke` | 同 Context 多 App 竞争、人类暂停后不自动抢占 |
| C15 | Worker Bash | Execute、stdin、stdout/stderr、Timeout、Signal、进程组回收、Shell 差异、大输出恢复 | `worker_contract.rs`、`execution_contract.rs` | Linux/macOS/Windows PowerShell 真实 Shell |
| C16 | Worker File | Read/Metadata/Outline、Glob/Grep 分页、Snapshot/Coverage、Write/Patch/Rewrite/Delete/Move | `file_tools_v2_contract.rs` | 文件竞争、软链、外部修改、预算分页、Context 快照独立 |
| C17 | Worker Tmux | Run/Input/Read/Inspect/Manage、Pane、Transcript、Handoff、Adopt、Worker Restart | `tmux_tools_contract.rs`、`test:worker:tmux`、`long-smoke` | Rust ignored 测试单独运行；Windows 内嵌 psmux `tmux_windows_contract.rs` |
| C18 | Terminal PTY | Attach、Input、Resize、Detach、Resume Sequence、Backpressure、Retire | `core/terminal`、`tui/terminal`、`control/terminal` | 跨 UI 切换和断线，不能因为 Client 断开杀 PTY |
| C19 | Artifact | ViewImage、Image Ref/Audit、Share/TTL/Range、Download Quota、Transfer、Direct/Relay、Cancel、GC | `control/artifact`、`ArtifactHttpRoute.test.ts` | 跨 Provider 和离线 Instance、内容大于 Budget、Restart Lease |
| C20 | Audit/Activity | ToolCall、Event、Log、SQLite、Cursor、Filter、Retention、原输出/图片恢复 | `core/audit`、`web/activity`、`mcpapp/Activity` | Activity 不依赖 Inline 卡片；大输出分页；Unscoped 的来源归属 |
| C21 | Message/Memory/Mailing | Comment Queue、Preference、#push/#stop/#resume、Memory init/inherit、Mailbox 投递/去重、Bounce | `extensions/comment/test`、`testspace comment-smoke`/`mailing-smoke` | 长会话/多 Context、同邮箱竞争、旧数据迁移、弱网连续投递 |
| C22 | Overview/Alerts | CPU/RSS/Disk、Git Changes、Script Probe、Instance Health、Warnings、降级渲染 | `OverviewService.test.ts`、`worker/workspace/alert.rs` | 多 Instance 局部失败不影响 Overview、告警变化传播 |
| C23 | Debug | List/Targets/Load/Release/Unload、Context Scope、超时和状态还原 | `control/debug`、`DebugPatchManager` | 跨 Context 隔离、异常 Patch 退役不阻断其他 Call |
| C24 | CLI/TUI/Web | 命令解析/Overlay/Wizard、TUI Terminal/Routes、Web Auth/Config/Audit/Todos/Connections | `cli/test`、`tui/test`、`web/test`、Chromium integration | 真实交互流、状态持续更新、OAuth/Approval UI、跨视图一致 |
| C25 | Install/Update/Migrate | 干净安装、版本切换、旧配置/DB 迁移、失败回滚、六平台资产 | `scripts/*.test.mjs`、`testspace upgrade-smoke` | 已支持旧 Schema→1.0、发布工件、远端升级和恢复 |
| C26 | Model Commands | Context-bound `devshell`、Native vs Model ACL、Provider 观察、Instance/Create、MCP/Skill/Secret | `cli/test`、`control/extension` | 模型 ACL 无回退、错误实例不能创建、多个 Agent Context |
| C27 | Execution Drivers | 有序 `execution.environment`、单选 `execution.sandbox`、Worker 进程环境继承 | `control/extension/api/point/execution`、`execution_contract.rs`、`extensions/direnv/test` | 真 Worker + direnv，失败保留有用环境和清理操作 |
| C28 | OIDC Provider | Issuer、Discovery Metadata、JWKS/签名 Key、Client/Subject、Token Endpoint、Token 验证和持久化 | `mcp/auth/Provider`、`mcp/OAuth.test.ts` | 重启后 Issuer/Client/JWKS 一致性、共享 Listener 下 Web/MCP Resource 隔离 |
| C29 | Hook System | Rewrite/Review/Execute 注册、优先级/排序、执行上下文、Cancellation、错误传播、Generation 退役 | `core/tool/Hook`、`control/extension/api/point/toolcall`、`core/Pipeline.test.ts` | 在途 ToolCall 与 Hook 热替换竞争、Source/Scope 权限不被改写、无旁路 |
| C30 | Extension Host | Install/Enable/Disable/Remove、静态 Manifest Catalog、Sandbox、Registration、Capability、Generation、Hot Reload | `control/extension/lifecycle`、`control/extension/api`、`testspace extension-smoke` | 损坏候选保留活跃版本、资源/Stream/进程回收、恢复再安装、各 Point 单独验收 |

## 4. Extension Host 与 12 个 Extension Points

Extension 的三个正交轴：**Capabilities（宿主授权资源）**、**Extension Points（对宿主提供的功能）**、**Generation Ownership（注册、进程、Stream、Lease 的生灭）**。不将 Endpoint/Transport 当作一个新的 Point。

| ID | Extension Point | 关键测试 | 现有入口 |
|---|---|---|---|
| P01 | `cli.native-commands` | Native Overlay，命令发现与帮助，Builtin Fallback、租约释放 | `control/extension/api/point/cli` |
| P02 | `cli.model-commands` | Context/Workspace ACL、Shim 身份校验、**绝不回退** Native/Builtin | `control/extension/api/point/cli` |
| P03 | `control.routes` | Control/Instance Scope，主体、Request、重复声明、Generation | `control/extension/api/point/control/Dispatch.test.ts` |
| P04 | `control.streams` | Subscribe/Cancel、Gap、Backpressure、Generation Retirement | `control/extension/Stream.test.ts` |
| P05 | `execution.environment` | 多 Driver 有序组合、Workspace 初始化、Worker 子进程继承 | `control/extension/api/point/execution` |
| P06 | `execution.sandbox` | 单 Driver 选择、信任边界、启动/退出生命周期 | `control/extension/api/point/execution` |
| P07 | `mcp.tools` | Dynamic Tool/Schema 注册、ToolCall Pipeline、删除后的 Catalog | `control/extension/api/point/mcp` |
| P08 | `tui.pages` | Page/Action/Refresh，Extension 退役后消失 | `control/extension/api/point/tui` |
| P09 | `toolcall.review` | Reject/Continue、顺序、Scope、Cancellation、Permission | `control/extension/api/point/toolcall` |
| P10 | `toolcall.rewrite` | Inbound/Outbound、Secret Invoker、不能篡改 Host/Scope | `control/extension/api/point/toolcall` |
| P11 | `web.applications` | iframe URI、生命周期、权限、卸载 | `control/extension/api/point/web` |
| P12 | `web.pages` | Snapshot/Action、Event 更新、Generation 退役 | `control/extension/api/point/web` |

Capability 单独验收：`assets`、`artifacts`、`config.core`、`context.observe`、`database`、`instance.observe`、`instance.manage`、`instance.events.publish`、`processes`、`toolcall.history`、`worker.execute`、`worker.delegate`。每项至少覆盖**授予、未授权、错误范围、重启/Generation 退休后回收**；禁止以 Extension 安装成功替代具体授权测试。

## 5. 每个 builtin Extension 的业务测试组

| ID | Extension | 分开的业务验收用例 | 测试入口 / 实际缺口 |
|---|---|---|---|
| X01 | `access` | Cloudflared/FRP/SSH Reverse、隧道启动/停止/重连、公网 URL 更新、进程回收 | `extensions/access/test`；公网/弱网待 E2E |
| X02 | `agent` | Provider 安装/版本/启停、Pi/OpenCode、Profile、Agent 生命周期、Delegate/Subagent、Web/TUI | `extensions/agent/test`；真实多 Agent 模型回合待验 |
| X03 | `artifact` | Share/Transfer/Status、model/native ACL、跨实例流、撤销和冲突 | `extensions/artifact/test` + `control/artifact`；Provider 组合待验 |
| X04 | `comment` | Message/Preference、Review Hook、Memory init/inherit、Mailing List、投递和去重 | `extensions/comment/test`；多 Context/重启弱网待验 |
| X05 | `direnv` | Driver 注入、路径切换、Environment Hook 顺序、Worker 继承 | `extensions/direnv/test`；真 Worker E2E 待验 |
| X06 | `instance` | list/status/logs/create、Remote Handle、Context 过滤/Mask | `extensions/instance/test`；多 Provider 管理 E2E 待验 |
| X07 | `mcp` | Profile CRUD、Server 连接、Tool List/Call、Timeout/Cancel | `extensions/mcp/test`；外部 Server E2E 待验 |
| X08 | `recall` | ToolCall SQLite 历史、过滤/分页、Provenance、只读授权 | `extensions/recall/test` + Control Recall integration |
| X09 | `secret` | 本地扫描、忽略规则、值不泄露、Rewrite/Scope、Placeholder | `extensions/secret/test`；多 Instance 组合待验 |
| X10 | `skill` | 全局/Managed/Project 三层目录、Search/Load/Read/Get、Artifact 分发 | `extensions/skill/test`；远端技能传输待验 |
| X11 | `storage` | Audit/Message Downgrade、导出/保留、不覆盖目标、旧 Schema 兼容 | `extensions/storage/test`；失败后恢复待验 |

决策边界：Approval 属于 Core；Direnv 使用 `execution.environment` Extension，不在 Worker 增加特别分支；Memory/Mailing 留在 Comment，不新增 MCP 工具；Instance Create 使用 Instance Extension 命令；独立 Ask/Question Store 已退役。

## 6. 运行门禁及证据的真实级别

| 范围 | 正式入口 | 证据级别与限制 |
|---|---|---|
| 所有 TS/JS Package 普通测试 | `pnpm test:packages` | U/I；`package-test-discovery.test.mjs` 防止深层文件遗漏 |
| 脚本 / 安装格式 | `pnpm test:scripts` | U/I；包括 release/testspace 入口 |
| Rust Worker 常规测试 | `cargo test --locked --workspace` | U/I；**不包含 `#[ignore]` 的 tmux 契约** |
| Rust Tmux 完整契约 | `pnpm test:worker:tmux` | Unix 专项 U/I，需 tmux |
| Windows psmux | `tmux_windows_contract.rs` | Windows 真实执行才是 P；Cross build 不代替 P |
| 独立 MCP App Receipt 压测 | `pnpm --filter @portable-devshell/mcp test:stress` | R，未纳入普通 MCP package |
| Transport 强压测 | `pnpm stress:transport` | R，需要受限 cgroup；不等价于通用 test |
| 真 Worker/MCP | `pnpm acceptance:worker`、`pnpm acceptance:mcp` | I/E；独立临时 HOME |
| 真 Web Chromium | `pnpm acceptance:web` | I/E；不等于 ChatGPT Host |
| 长等待 Handoff | `pnpm acceptance:tmux-handoff` 或 `pnpm testspace long-smoke` | E，跨过 180 秒 |
| Testspace 基础 | `pnpm testspace smoke` | E：Local + Reverse，不包含所有专项 Smoke |
| Testspace 专项 | `web-smoke`、`comment-smoke`、`mailing-smoke`、`mcpapp-smoke`、`workflow-smoke`、`approval-smoke`、`update-smoke`、`upgrade-smoke` | E；部分 Host 行为模拟，参见各 smoke 说明 |
| Extension 损坏候选 | `pnpm testspace extension-smoke` | E；会短暂修改 Testspace 的安装 Manifest，**只手动独占执行** |
| 真实 Host 和公网 | ChatGPT + 授权的实际 URL / Provider | H；需要独立记录，不以 Testspace 模拟替代 |
| 六平台发行 | CI `verify-target` / Release | 构建可用性；Windows 运行时 P 单列 |

### 并行测试扩展分工（文件互斥）

| 组 | 优先补齐 | 允许修改的测试目录 |
|---|---|---|
| A | Control/Instance/Config/Extension Host：异常隔离、Lease、竞态 | `packages/control/test` |
| B | MCP/OAuth/MCP App：真实 Route、鉴权、Receipt/Reentry | `packages/mcp/test` |
| C | Core/Transport/Task：Frame/Stream、Pipeline、Wait、Approval | `packages/core/test`、`packages/shared/test` |
| D | Worker/Tmux/File：执行、并发、跨 Context、持久状态 | `crates/devshell-worker/tests` |
| E | Comment/Mailing/Memory：多 Context、去重、恢复 | `extensions/comment/test` |
| F | 其余 Extensions：能力边界、生命周期、Direnv/Agent/Skill | `extensions/access/test`、`extensions/agent/test`、`extensions/artifact/test`、`extensions/direnv/test`、`extensions/instance/test`、`extensions/mcp/test`、`extensions/recall/test`、`extensions/secret/test`、`extensions/skill/test`、`extensions/storage/test` |

要求：新增测试只断言已经确定的功能决策；默认不修改业务源码、Config、生产目录或现有 Testspace。六组结束后由主集成者执行统一回归、按 scope 提交，并把真实 E2E 未验项继续保留为待验，不制造“全覆盖”结论。


## 7. 本轮新增回归用例的追溯索引

以下条目是已编写的**具体断言**，不是“整个模块已完成验收”的标签。即使 U/I 通过，L01–L08 中的 H/P/R 缺口仍独立存在。

| 用例组 | 覆盖功能 ID | 测试文件 | 新增断言与失效条件 |
|---|---|---|---|
| T01 | C03 | [EditorLifecycle.test.ts](../../packages/control/test/unit/control/instance/EditorLifecycle.test.ts) | Disable 清理债务重试后才能恢复新一代 Instance；配置写入失败不得伪造完成或破坏 revision |
| T02 | C05 | [Credential.test.ts](../../packages/control/test/unit/control/reverse/Credential.test.ts) | Reverse Credential 替换激活失败后保留可重试的凭据关系 |
| T03 | C22 | [OverviewService.test.ts](../../packages/control/test/unit/control/OverviewService.test.ts) | 单个 Instance 的 RPC 采集故障不拖垮 Overview，恢复后告警解除 |
| T04 | C23 | [Service.test.ts](../../packages/control/test/unit/control/debug/Service.test.ts) | Scoped Debug Patch 异常退出后不污染另一个 Context，旧 Patch 可以替换 |
| T05 | C30/P03 | [Dispatch.test.ts](../../packages/control/test/unit/control/extension/api/point/control/Dispatch.test.ts) | Control Route 执行失败释放 Generation Lease，后续请求身份与 request context 不串线 |
| T06 | C30/P04 | [Stream.test.ts](../../packages/control/test/unit/control/extension/Stream.test.ts) | 相同 Generation 重新激活时关闭旧订阅；未授权观察立即撤销 Stream/Lease |
| T07 | C09 | [Context.test.ts](../../packages/mcp/test/unit/Context.test.ts) | Context 不能被另一 principal 解析，但仍对原 owner 有效 |
| T08 | C09/C11 | [Ingress.test.ts](../../packages/mcp/test/unit/endpoint/Ingress.test.ts) | 越权 Context 在进入 ToolCall Ingress 前被拒绝，执行计数保持零 |
| T09 | C11 | [Http.test.ts](../../packages/mcp/test/integration/Http.test.ts) | 运行时 Tool Catalog 移除旧工具后，旧 recipient 返回 `core.toolSchemaUnavailable` 而非继续 Execute |
| T10 | C07/C29 | [Pipeline.test.ts](../../packages/core/test/unit/tool/Pipeline.test.ts) | 一个 Context 的 Review Denial 不影响另一个 Context 的 Rewrite/Execute/Audit |
| T11 | C08 | [Service.test.ts](../../packages/core/test/unit/approval/Service.test.ts) | 竞争的人类审批最终只有一个持久化胜者和一个终态事件 |
| T12 | C14 | [Wait.test.ts](../../packages/core/test/unit/task/Wait.test.ts) | 同一目标下多 Context Wait 各自恢复且只启动一次 Monitor |
| T13 | C14 | [Goal.test.ts](../../packages/core/test/unit/task/Goal.test.ts) | 并发 Claim 只能有一个 Owner，人工 Pause 持久化并阻止旧 Claim 继续 |
| T14 | C06 | [Stream.test.ts](../../packages/shared/test/unit/transport/frame/Stream.test.ts) | RESET 释放阻塞的 Writer 和 Reader，不损坏其他 Protocol/Channel |
| T15 | C06 | [ReplayRecovery.test.ts](../../packages/shared/test/unit/transport/ReplayRecovery.test.ts) | 重连从正确游标继续消费；Stop 后订阅正确关闭 |
| T16 | C27/P05 | [execution_contract.rs](../../crates/devshell-worker/tests/execution_contract.rs) | 可选 Environment Driver 的半完成环境回滚；必需 Driver 失败后再次执行不泄漏环境 |
| T17 | C16 | [file_tools_v2_contract.rs](../../crates/devshell-worker/tests/file_tools_v2_contract.rs) | 不跨 Context 扩大已读 coverage；旧 revision 被拒绝后重新读取可恢复编辑 |
| T18 | C17 | [tmux_tools_contract.rs](../../crates/devshell-worker/tests/tmux_tools_contract.rs) | tmux 服务丢失后会重建会话，不能把旧 Task 误当成仍活跃的 Task |
| T19 | C21/X04 | [Mailing.test.ts](../../extensions/comment/test/unit/Mailing.test.ts) | 并发 Mailing 扫描、Memory 认领唯一 Owner、失败投递持久化恢复、Context Scope 不越界 |
| T20 | C21/X04 | [CommentRecovery.test.ts](../../extensions/comment/test/unit/CommentRecovery.test.ts) | 并发 Comment Consumer 去重、失败 Resume 保留 Stop、Push Budget 跨重启并由 Report 清除 |
| T21 | X02 | [AgentModelCommand.test.ts](../../extensions/agent/test/unit/AgentModelCommand.test.ts) | Model Agent 无法控制其他 Context 的 Agent；越界启动结果由 Runtime 回收 |
| T22 | C12/X07 | [McpHttpClient.test.ts](../../extensions/mcp/test/integration/McpHttpClient.test.ts) | 真 Streamable HTTP Server 返回工具错误后 Client 连接仍可继续调用 |

### 仍不能凭新增测试宣称通过的场景

- 真实 ChatGPT Host 的 Inline / Fullscreen、工具卡长期存在、OAuth 登录、人机 Approval 和自动 `sendMessage` 交付（H）。
- SSH、Docker、Podman 的真实 Provider 全组合；Windows x64/ARM64 内嵌 psmux/PowerShell 运行态（P）。
- 有依赖修改的 `extension-smoke`、发行包 `upgrade-smoke`、长达 180 秒的真实 `long-smoke` 需在独立验收环境按需执行（E/R）。
- 丢包、网络半断开、跨机大文件传输、并发长时间运行、内存和 FD 压力仍属于后续可靠性证据（R）。

## 8. 测试覆盖缺口台账（按独立断言）

状态区分**存在用例、定向验证、默认CI入口、真实目标平台验收**，不能因局部Mock通过就宣称E2E已覆盖。这里的“自动”表示默认测试脚本发现该测试，不代表本轮已在GitHub Runner上运行。缺失专项不应自动阻断无关业务运行。

| Gap ID | 功能 | 需要验证的不变量 | 证据入口（相对模块路径） | 当前层级/状态 | 门禁 | 尚缺证据 |
|---|---|---|---|---|---|---|
| G01 | C02 | Config Journal发布、部分Instance替换、旧文件删除后SIGKILL；重启恢复同一完整Generation | control/config/persistence/CrashRecovery.test.ts | I 已新增、定向通过 | Package自动 | 断电/Windows文件系统耐久待验 |
| G02 | C25 | Context/Audit迁移过程中SIGKILL；重启后保留记录、幂等 | control/migration/Context.test.ts + Audit.test.ts | I 已新增、定向通过 | Package自动 | 跨所有迁移Domain的整包恢复待验 |
| G03 | C05 | Reverse同实例凭据撤销与新WSS/SSE激活竞争，旧连接无执行权 | control/reverse/ActivationRace.test.ts | I 已新增、定向通过 | Package自动 | 真实公网/弱网仍待验 |
| G04 | C03 | 同名Instance旧Generation清理不能回收新Worker/Container | control/instance/EditorLifecycle.test.ts + control/integration/server/InstanceDeleteRecovery.test.ts | I 已新增、定向通过 | Package自动 | 真实远端可再次连通的旧资源待验 |
| G05 | C04 | SSH安装→启动→工具调用→重连与清理 | core/worker/Transport.test.ts | U 已有 | Package自动 | 真实SSH目标E2E未覆盖 |
| G06 | C04 | Dockerfile镜像复用与构建失败不启动容器；恢复后允许重试 | core/worker/Transport.test.ts | U 已新增、定向通过 | Package自动 | Docker实际创建与握手待验 |
| G07 | C04 | Compose暂启容器、Retire失败后恢复原运行状态 | core/worker/Transport.test.ts | U 已新增、定向通过 | Package自动 | 真实Compose错误组合待验 |
| G08 | C04 | Rootless Podman安全变量隔离、keep-id与容器UID继承 | core/worker/Transport.test.ts | U 已新增、定向通过 | Package自动 | Rootless Podman真机验收待验 |
| G09 | C26/P02 | 伪造Parent ToolCall/Context/Workspace/Task身份证据时Model CLI副作用为零 | control/extension/ModelCommandBroker.test.ts | U 已新增、定向通过 | Package自动 | 真MCP跨Instance父调用待验 |
| G10 | C27/P06 | Environment Hook有序组合、只选择一个Sandbox、退出资源释放 | control/extension/ExecutionDrivers.test.ts | U 已新增、定向通过 | Package自动 | 自定义Sandbox→Worker真实执行待验 |
| G11 | C07/C08 | 取消后迟到Approval无法复活ToolCall | core/approval/Service.test.ts | U 已新增、定向通过 | Package自动 | 真MCP长等待/Worker执行组合待验 |
| G12 | C29 | 一个Context Rewrite失败不污染他人；出站变错误只执行一次 | core/tool/Pipeline.test.ts | U 已新增、定向通过 | Package自动 | 在途Extension热替换待验 |
| G13 | X09 | 并发Context解析同名不同Secret不会泄露或串值 | secret/SecretRewrite.test.ts | U 已新增、包测试通过 | Package自动 | Extension Sandbox和真Worker待验 |
| G14 | C10/C28 | OIDC重启后Issuer/JWKS/Client/Token一致，跨资源Audience拒绝 | mcp/integration/OAuthRestart.test.ts + ContextIsolation.test.ts | I 已新增、MCP包测试通过 | Package自动 | 完整重启与公网Host验收待验 |
| G15 | C06 | RPC已执行、回复丢失后不重复执行；Stream游标正确重播 | shared/transport/ReplayRecovery.test.ts | U 已有 | Package自动 | 真实Worker副作用与Audit恢复待验 |
| G16 | C19 | Chunk Offset/Hash错误后失败并清理Source Lease和Target Receive | control/artifact/Service.test.ts | U 已新增、定向通过 | Package自动 | 跨Provider大文件/Control重启待验 |
| G17 | X05/P05 | 真Direnv CLI的Export/Unload、cwd切换、子进程环境继承 | direnv/DirenvCli.test.ts | I 已新增、包测试通过 | Package自动 | 已安装Extension→真Worker待验 |
| G18 | C12/X07 | MCP Client阻塞Connect/Call后Abort并可恢复新请求 | mcp-extension/McpHttpClient.test.ts | I 已新增、包测试通过 | Package自动 | 实际外部Server ACL组合待验 |
| G19 | X10 | Skill投影失败后从新快照正确重试 | skill/SkillCommand.test.ts | U/I 已新增、包测试通过 | Package自动 | 跨Worker传输与Model Load待验 |
| G20 | C15-C18 | 真Worker取消、File、PTY/Tmux恢复与输出资源 | worker/beta_ipc_contract.rs + worker_contract.rs | I/P Linux已新增、Rust测试通过 | Rust自动/Tmux专项 | Windows和跨UI高输出待验 |
| G21 | C24/L03 | Web/TUI并发Revision/操作禁用及权威刷新 | web/test/view/page/Todos.test.tsx + tui/test/interaction/Navigation.test.ts | U/I 已新增、包测试通过 | Package自动 | Web/TUI/CLI三端共享RPC验收待验 |
| G22 | C30/L06 | 安装Extension持有多个真实Worker后退役旧Generation不串Instance | control/integration/extension/Retirement.test.ts | I 已新增、定向通过 | Package自动 | 真实双Worker与慢Stream关闭待验 |
| G23 | L08/C25 | v0.7.7→当前发行包迁移、失败回滚，旧版数据仍可用 | `scripts/testspace/TestspaceUpgradeSmoke.mjs` | **E：本轮真实发行包 8/8 场景通过** | 独立 Testspace 运行；GitHub Extended CI 仍待实跑 | 正常升级、Comment恢复、失败启动回滚、坏Audit延后、旧Schema拒绝和3类Context/Instance断连事故均通过；Windows/macOS升级待验 |
| G24 | L06 | 损坏Extension候选保留旧Generation，恢复后释放旧资源 | TestspaceExtensionSmoke.mjs | E 已有但专项未运行 | 手动Extended CI | 新增extension专项入口；实际Runner待验 |
| G25 | C17/P | Windows x64/ARM64 PSMUX Pane/Task/PowerShell与Worker重启 | tmux_windows_contract.rs | P 专项待验 | 手动Extended CI | 新增双Windows runner；实际测试未执行 |
| G26 | C13/H | 真实ChatGPT Fullscreen/Inline/Approval/Reentry/历史卡片恢复 | McpAppReactBrowser.test.ts | H 未验 | 手动Host | 现有Chromium用测试Host替身 |
| G27 | C06/R | 慢读者、弱网重连、流背压及资源有界 | `scripts/stress-transport.mjs` | **R：已执行；8条Transport压力断言通过，整轮未全绿** | 独立systemd cgroup（MemoryMax 1.5 GiB、CPU 150%） | Reverse WSS第7/8轮观察到前代Token尚可认证，可能是snapshot ready领先最终凭据提交；增补激活完成点确定性测试，整套压力复跑仍待结论 |
| G28 | C21/X04 | 真实Worker Mailing的提交中断后重启保证Inbox/Index/通知不重复 | extensions/comment/test/unit/Mailing.test.ts | U已有 | Package自动 | 真Worker中途故障注入待验 |
| G29 | C14 | 两个App Lease争用Claim、人类Pause使旧指令失效 | mcp/mcpapp/Reentry.test.ts | U已有 | Package自动 | 真实Host多iframe竞争待验 |
| G30 | C20 | 工具已执行而Completion Audit提交失败时重启不出现假成功 | core/tool/Pipeline.test.ts + Provenance.test.ts | U已有 | Package自动 | 完整Control/Worker强制崩溃待验 |

| G31 | C09/C10 | 不同 OAuth Principal 不能读写其他 Context 的状态 | mcp/integration/ContextIsolation.test.ts | I 已新增、MCP包测试通过 | Package自动 | 实际 ChatGPT/OAuth Client Header 端到端仍待验 |
| G32 | C06/C20 | ToolCall 已产生副作用而回复丢失时，重连后不得默默重复执行 | control/integration/server/transport/ControlRpcServer.test.ts | I 已新增、定向通过 | Package自动 | 真 Worker 跨机弱网/审计提交中断仍待验 |

## 9. 第三轮缺陷导向测试矩阵

本轮七个 Codex 长任务按“实现入口→可证伪不变量→故障注入/交错→定向实测→Bug复现”多轮执行。下表是**行为组**而非以文件数量充当覆盖率；同一行的多个断言共享测试入口。优先区分绿色默认回归、独立已知缺陷红测、真实 E2E 和仍缺的目标平台运行证据。

详见 [第三轮实际 Bug 与复现](beta-bug-findings.md)；已证实但尚未修复的红测在仓库内 [Known-Bugs](../../test/known-bugs/README.md)，不会影响正常 Package 默认发现。

| Matrix ID | 功能关联 | 新增可证伪断言 | 具体入口 | 证据层级 | 门禁与实测状态 |
|---|---|---|---|---|---|
| M01 | C02/C25 | Recovery本身再次 SIGKILL、半提交/清理失败，保留一致Generation | control/config/persistence/RecoveryInterruption.test.ts | I | 自动Package；新增 |
| M02 | C05/L04 | Reverse Credential发布/轮换中进程死亡与重启，旧凭据无错误恢复 | control/reverse/CredentialCrash.test.ts | I | 自动Package；新增 |
| M03 | C03 | 同名Instance删除与新代资源创建交错 | control/instance/GenerationDeletion.test.ts | U/I | 自动Package；新增 |
| M04 | C25/L08 | SQLite Migration写入/提交异常后的重试幂等 | control/migration/AuditFaultRetry.test.ts | I | 自动Package；新增 |
| M05 | C30/P01-P12 | Extension Point注册、变更和Capability归属失效分支 | control/extension/Round3Matrix.test.ts | U/I | 自动Package；新增 |
| M06 | C30/L06 | Extension Host Generation退役、资源/回调生命周期 | control/integration/extension/Round3Lifecycle.test.ts | I | 自动Package；新增 |
| M07 | C04 | Docker/Podman adopted runtime、Provider重连/命令失败后恢复 | core/worker/Transport.test.ts | U/I | 自动Package；新增 |
| M08 | C06 | Stream窗口耗尽、多个挂起Reader、FIN/RESET清理与顺序 | shared/transport/frame/Stream.test.ts | U | 自动Package；新增 |
| M09 | C28 | OIDC Issuer/JWKS/Discovery和资源元数据负例 | mcp/auth/OAuthMetadataRound3.test.ts | U/I | 自动Package；新增 |
| M10 | C10 | OAuth注册/签名/刷新竞争边界与令牌有效性 | mcp/auth/OAuthRound3.test.ts | U/I | 自动Package；新增 |
| M11 | C10/L02 | 现有连接上的认证变更与作用域变更 | mcp/auth/OAuthSocketRound3.test.ts | I | 自动Package；新增 |
| M12 | C09 | Principal+Workspace绑定，多Context参数隔离 | mcp/ContextRound3.test.ts | U/I | 自动Package；新增 |
| M13 | C13/C14 | MCP App Action Lease领取/释放、多候选并发 | mcp/mcpapp/LeaseRound3.test.ts | U | 自动Package；新增 |
| M14 | C13 | MCP App Live Snapshot状态与恢复请求序号 | mcp/mcpapp/LiveRound3.test.ts | U/I | 自动Package；新增 |
| M15 | C14/L05 | Goal/Receipt Reentry领取-校验-汇报负例 | mcp/mcpapp/ReentryRound3.test.ts | U/I | 自动Package；新增 |
| M16 | X01 | Access Tunnel退役后过期事件不得修改新配置 | extensions/access/test/unit/Runtime.test.ts | U | 自动Package；新增 |
| M17 | X02 | Agent子进程身份/事件隔离、并发取消恢复 | extensions/agent/test/unit/PiSubagent.test.ts | U/I | 自动Package；新增 |
| M18 | X03 | Artifact Model跨Workspace来源/目标可见性 | extensions/artifact/test/unit/ArtifactModelCommand.test.ts | U | 自动Package；新增 |
| M19 | X06 | Instance Model Command遮蔽范围和重建后的列表/日志 | extensions/instance/test/unit/InstanceCommand.test.ts | U | 自动Package；新增 |
| M20 | X08 | Recall跨Instance/Workspace历史过滤和分页 | extensions/recall/test/unit/RecallExtension.test.ts | U | 自动Package；新增 |
| M21 | X11 | Storage Downgrade异常/cancel与旧文件保护 | extensions/storage/test/unit/StorageDowngrade.test.ts | U/I | 自动Package；新增 |
| M22 | C24/L03 | Web Config/Todo/Audit真实渲染、异步状态与操作反馈 | packages/web/test/view/BetaMatrixRound3.test.tsx | U/I | 自动Package；新增 |
| M23 | C24 | TUI实例/审查界面焦点、选中项与命令响应 | packages/tui/test/view/BetaMatrixRound3.test.ts | U/I | 自动Package；新增 |
| M24 | C13/L05 | MCP App真实渲染组件的Reentry/Action/Watch与刷新 | packages/mcpapp/src/BetaMatrixRound3.test.tsx | U | 自动Vitest；新增 |
| M25 | C15-C18 | 真实Rust Worker Bash/File/Terminal取消和最大Seq边界 | crates/devshell-worker/tests/beta_ipc_contract.rs | I/P Linux | Rust Workspace自动；新增 |
| M26 | L06 | 独立Namespace中Control/Reverse/Extension/Mailing/Workflow/Approval贯通 | pnpm testspace / TestspaceExtensionSmoke.mjs | E | 本轮实跑全流程通过 |
| M27 | C17/C18 | Terminal.attach u64::MAX不得溢出、Timeout或误判Gap | crates/devshell-worker/tests/beta_ipc_contract.rs | I | 真实Worker复测通过；已修复 |
| M28 | L06/C30 | 外层UID与UserNamespace内UID不同，XDG_RUNTIME_DIR仍一致 | scripts/testspace.test.mjs | I/E | 跨进程+独立Testspace通过；已修复 |
| M29 | C02/C10/C14/C30 | 独立Known-Bugs红测保留真实实现偏差，默认门禁不加载 | test/known-bugs/README.md | I/UI | 独立显式运行并保持红色，见缺陷台账 |

## 10. 第四轮长任务补测与真实验收

本轮增加的是**独立可证伪不变量和实际运行记录**，并不使用测试文件数充当端到端覆盖率。红色缺陷复现均显式运行，尚未修复的行为绝不能为追求全绿改写期望。主要结果见[第四轮缺陷台账](beta-bug-findings.md)。

| 测试组 | 关联 | 独立验证 | 证据入口 | 层级 | 执行结果与仍缺证据 |
|---|---|---|---|---|---|
| R401 | L08/C25 | 真实0.7.7升级、Comment/Agent/Audit/Context迁移、失败回滚 | pnpm testspace upgrade-smoke | E | 8/8实际通过，Windows/macOS待验 |
| R402 | C06/G27 | Frame/Packet背压、多路复用、32MiB真实Worker Artifact及Reverse 8轮压力 | pnpm stress:transport | R | 基础8条全过；Reverse第7轮WSS断言失败，整套未通过 |
| R403 | C05 | 凭据新代认证前旧Token保留，完成后撤销；失败不误撤销 | control/reverse/TokenActivationBoundaryRound4.test.ts | U/I | 2条实际通过 |
| R404 | C05/L04 | Reverse旧Generation/Stop期间的Candidate Admission | control/reverse/GenerationAdmissionRound4.test.ts | U/I | 2条实际通过 |
| R405 | C04/G05-G08 | Podman容器管理、启动与删除故障、Runtime重建 | core/worker/provision/ContainerLifecycleRound4.test.ts | U/I | 4条实际通过；重建归属缺陷红测待修 |
| R406 | C15-C18 | 真Worker绝对路径/符号链接防逃逸、Bash cwd、文件模式和并发IPC | crates/devshell-worker/tests/beta_round4_boundary.rs | I Linux | 6条真实Worker通过，Windows未验 |
| R407 | C19/L07 | Artifact后段坏Chunk、Offset/Hash中断、Archive越界和覆盖冲突 | control/artifact/Service.test.ts + Archive.test.ts + ArtifactHttpRoute.test.ts | U/I | 真实HTTP/本地Store已通过，跨机Provider仍待验 |
| R408 | C07/C08/C20 | 32交错ToolCall、执行后出站失败、Review/Approval/SQLite、RPC重连 | control/integration/server/transport/ToolCallRound4.test.ts | I | 新增10条通过，Error Projection和Service Close独立红测 |
| R409 | C10/C28/C09 | OAuth双Client、Audience/Scope、Revoke、JWKS复用及SSE Cancel | mcp/test/integration/*Round4.test.ts | I | 16条通过：Memory HTTP +真SDK/OIDC/SQLite；公网TCP待验 |
| R410 | C21/X04 | Comment/Mailing真SQLite关闭重开、进程异常退出、消息原文和损坏恢复 | extensions/comment/test/unit/*Durability.test.ts | U/I | 新增16条通过，断电/ENOSPC待验 |
| R411 | C21/X04/G28 | Memory Init/Inherit、Mailing并发与真Rust IPC重启去重 | extensions/comment/test/integration/MemoryIpc.test.ts | I | 真Worker执行通过，已加入Comment默认Package |
| R412 | C24/L03 | Web Config/Audit/Approval分页、异步刷新和跨Instance操作 | packages/web/test/view/BetaMatrixRound4.test.tsx | U/I | 10条通过；另4条组件级红测 |
| R413 | C24/L03 | TUI焦点、实例切换、确认Overlay与状态更新 | packages/tui/test/view/BetaMatrixRound4.test.ts | U/I | 7条通过；另3条组件级红测 |
| R414 | L03/G30 | 真Control/Worker重启、Audit/Todo/日志保持、262条Revision重放/Gap | pnpm testspace recovery-smoke | E | 真实3轮：前置恢复通过，删除cleanupPending后retry仍未清零，整套红 |
| R415 | C03/G04 | 删除提交后公共Cleanup Retry必须清理旧Worker资源并允许同名重建 | scripts/testspace/TestspaceRecoverySmoke.mjs | E | 真实实例删除补偿失败；作为待修复缺陷 |
| R416 | C14/C20 | 原生MCP AbortSignal应在SQLite记为cancelled，不是普通failed | test/known-bugs/McpNativeAbortAudit.test.ts | I | 独立红测：CONNECTION_CLOSED |
| R417 | C20/L02 | Control RPC普通与Stream路径应保留executionCompleted和failureStage | test/known-bugs/ToolCallAuditBoundary.test.ts | I | 独立红测，ApprovalService.close竞态另有红测 |
| R418 | C21/X04 | Mailing按Instance Scope去重，引用标记不能吞邮件，Ack失败后不重复 | test/known-bugs/CommentMailingDelivery.test.ts | I | 真SQLite/磁盘，4条独立红测 |
| R419 | C24 | Web Audit页码缩减、迟到详情、同Approval ID不同Instance并发 | test/known-bugs/ui/web-round4-repro.config.ts | UI | 4条组件级红测，1条为Round3重复确认 |
| R420 | C24 | TUI正在确认时Escape和旧Future不能污染新实例Overlay | test/known-bugs/TuiOverlayLifetime.test.ts | UI | 3条组件级红测，真实远端Host待验 |

仍待真实验收的关键项：Windows x64/ARM64 原生 psmux 会话（G25）；ChatGPT Host OAuth、Approval、Reentry与历史卡片（G26）；真实 SSH/Rootless Podman、跨机 Reverse 弱网和断线（G05–G08/G27）；断电、ENOSPC、持久化故障；真实浏览器 Audit/Revision 长连接行为。脚本存在或内存 HTTP 通过均不能自动关闭这些缺口。

## 11. 第五轮补测：真实资源回收、WSS 与 MCP HTTP

本轮新增的是实际可证伪行为和独立运行证据，而非仅计数测试文件。普通门禁的通过数量不包含独立已知BUG红测；本地Mock/React也不等于真实跨机与Windows验收。

| 编号 | 关联 | 行为与故障边界 | 证据入口 | 执行层级 | 结果与限制 |
|---|---|---|---|---|---|
| R501 | G03/G04 | 隔离Testspace中三种Instance删除/Stop/重启后同名重建 | pnpm testspace retirement-smoke | 真Control/Worker E2E | 3/3通过；已Stop清理 |
| R502 | G04/C25 | 旧代Cleanup Debt持久化、并发Retry、真Rust Retire/Stop | control/test/{unit/control/instance,integration/server}/Round5* | 本地集成 | 10/10通过，另有独立红测 |
| R503 | C05/G27 | WSS提交屏障和16代Churn，SSE POST并发去重 | control/test/integration/ReverseTransportRound5.test.ts | 真WSS/SSE | 4/4通过 |
| R504 | C05/G27 | Reverse Admission候选退役/撤销后拒绝旧代 | control/test/unit/control/reverse/*Round5.test.ts | State/Store单测 | 8/8通过 |
| R505 | C15-C18 | 真Worker Terminal replay、Tmux、并发Bash取消和FileEdit原子重试 | crates/devshell-worker/tests/beta_round5_ipc.rs | 真Linux IPC | 6/6通过，Windows未验 |
| R506 | C02/G04 | CLI Delete Pending、Cleanup Retry与Reverse enroll出错提示 | packages/cli/test/command/Round5Lifecycle.test.ts | 命令层测试 | 8/8通过，真实SSH/Podman未验 |
| R507 | C10/C28 | Bearer scope/audience、双Client、请求体限制、SSE和路由恢复 | mcp/test/integration/Round5NativeHttp.test.ts | 真127.0.0.1 TCP/OIDC/SQLite | 16/16通过 |
| R508 | C10/C28 | 同Refresh Token并发重放拒绝，但已签发Token仍有效 | test/known-bugs/McpRefreshConcurrentReplayRound5.test.ts | 真TCP红测 | HTTP200非401，独立失败 |
| R509 | C14/C24 | MCP App Approval/Wait、Revision、Reentry与Context刷新 | mcpapp/src/BetaMatrixRound5.test.tsx | 真React | 13/13通过 |
| R510 | C14/C24 | 旧Context指令错误Claim和迟到Snapshot覆盖新Context | test/known-bugs/ui/mcpapp-round5-repro.config.ts | React红测 | 2条独立失败，服务端尚未证实可绕过 |
| R511 | C24/L03 | Web SQLite重启的Audit/Todo/Goal、实例删除Debt提示 | web/test/view/Round5Runtime.test.tsx | 真SQLite+React | 10/10通过；真浏览器Audit交互和恢复未验 |
| R512 | G04/C25 | 旧Worker PID残留与跨Control重启Cleanup Retry失败 | test/known-bugs/{ControlCleanupRetryRound5,WorkerRetireStalePidRound5}.test.ts | 真Rust+Control IPC红测 | 2条独立失败；显式Stop可恢复 |
| R513 | C25 | 专用Retirement Smoke不隐瞒未清Debt且仅手动派发 | scripts/testspace.test.mjs | 脚本回归 | 4/4通过 |
| R514 | C24/L03 | 独占Testspace和真实Chromium CDP检查WebUI加载、在线状态与实例可见 | pnpm testspace web-smoke | 浏览器E2E | 实际通过：online和instanceVisible为true；未启用Audit Reload和实例Start/Stop |

仍未验证：跨机SSH/Podman/Reverse弱网、Windows x64/ARM64原生psmux、真实ChatGPT Host MCP App（Approval/Wait/历史卡片）、跨Worker Artifact超长流、ENOSPC/断电持久化与直接删除正在运行Worker的自动补偿。这些不能因为本轮本地测试通过而消除。

## 12. 第六轮测试矩阵：跨模块并发、弱网与故障恢复（2026-10-20）

**红色复现独立运行，不得通过弱化预期混入默认全绿测试。** 测试层级严格区分真实Linux Worker、localhost TCP/HTTP/WS、受控文件系统故障注入、可执行Fake Provider CLI和真实浏览器。压力测试由systemd user cgroup限制内存、CPU和进程。

| ID | 功能 | 断言/场景 | 证据入口 | 实际状态及边界 |
|---|---|---|---|---|
| R601 | C02/C25 | Config TOML multi-instance rename/fsync EIO + ENOSPC rollback; isolated process restart | control/test/unit/control/config/Round6ConfigDurability.test.ts | 10/10; real filesystem with injected I/O faults, not disk exhaustion |
| R602 | C04/G05-G08 | SSH/container start, installer retry, corrupt upload, argv/env and cleanup | core/test/unit/worker/provision/Round6ProviderLifecycle.test.ts | 15/15; executable fake SSH/Podman CLI, not remote providers |
| R603 | C07/C20 | Real side effects, review, cancellation and durable SQLite Audit | core/test/unit/tool/Round6AuditProvenance.test.ts + control/test/integration/server/transport/Round6ToolCallAudit.test.ts | 11/11 with real local files and SQLite/Control Target |
| R604 | C20/L02 | Effect committed before adapter error, yet retryable remains true | test/known-bugs/ToolCallAdapterRetryAfterCommitRound6.test.ts | Independent real-file/SQLite RED; expected exit 1 |
| R605 | C07/C20 | Duplicate active callId rejected but overwrites original ctxId/requestId audit | test/known-bugs/ToolCallDuplicateAuditOwnershipRound6.test.ts | Independent real-Control/SQLite RED; expected exit 1 |
| R606 | C15-C18 | Concurrent terminal, max cursor, tmux postclose output, symlink/dir permissions, cancel/restart | crates/devshell-worker/tests/beta_round6_execution.rs | 10/10 native Linux Rust Worker IPC |
| R607 | C23/C24 | TUI async focus and overlay ownership, preserved events, CLI Gap/reconnect cursor | tui/test/view/BetaMatrixRound6.test.ts + cli/test/transport/Round6Reconnect.test.ts | 10/10 Dispatcher and Shared Endpoint; not native remote TUI |
| R608 | C05/L04 | WSS fragment/reliable frames, handshake 20s, SSE partial POST/ACK, queued candidates and credential generations | control/test/integration/ReverseNetworkRound6.test.ts + control/test/unit/control/reverse/ReverseNetworkRound6.test.ts | 14/14 REAL localhost TCP/WSS/SSE, Store |
| R609 | C05/L04 | Failed newer WSS handshake poisons retained reliable session of older active Worker | test/known-bugs/ReverseCandidateFailurePoisonsPreviousRound6.test.ts | Independent real WebSocket RED; stale generation / rpc.resultUncertain |
| R610 | C06/G27 | 256 streams, 8MiB backpressure, 32MiB real Worker RPC + eight WSS/SSE gateway rounds + Rust Reverse carrier | pnpm stress:transport | cgroup-bounded; baseline 8/8 and Gateway 8/8, Exit 0 |
| R611 | C24/L03 | Chromium Audit survives real page reload; real WebUI Worker stop/start | pnpm acceptance:web | REAL browser CDP, isolated HOME, Exit 0 |
| R612 | C17/L05 | 190s tmux task; 180s detached handoff and successful final read | pnpm acceptance:tmux-handoff | real Worker; detachedAfterMs=180093, finalReadMs=10049, status 0 |
| R613 | C25 | Opt-in manual browser/handoff CI with isolated AcceptanceFixture | scripts/beta-matrix-extended.test.mjs + .github/workflows/beta-matrix-extended.yml | Script check passed; GitHub Runner not invoked |
| R614 | C05/G27 | Original stress checked token before credential commit; now waits protocol DSR2 ready | control/test/integration/ReverseConnectionGateway.test.ts | Retains strict stale-token rejection; 8/8 actual Gateway rounds after test fix |

持续未实测的关键场景：真实远端SSH/Rootless Podman部署，Windows x64/ARM64的本轮原生psmux运行，真实ChatGPT Host里的MCP App，磁盘实际断电/ENOSPC和跨机Artifact传输；不能把上表的Fake CLI或本地WebView测试当成这些平台已通过的依据。

## 13. 第七轮：真实跨Domain功能链整体验收

上一至六轮的单元/集成数量不等于跨Domain整链覆盖。第七轮首次将四条独立、故障可重放的真实链组合为一个可执行矩阵；其后在2026-10-20 Beta修复了两条链的真实断点以及执行前Web审批入口。公开入口详见 [完整功能链验收与故障台账](functional-chain-acceptance.md)。`acceptance/run-chain-matrix.mjs --all` 完整运行每条链，单条失败不会跳过其他链，最终状态以实际退出码为准。

| 功能链 | 真实端到端执行路径 | 失败与恢复注入 | 本轮真实验收状态 |
|---|---|---|---|
| **E701 / L07 Artifact** | MCP SDK → Control → Worker A bash_run → Artifact Store → Lease/HTTP → Control Relay → Worker B → Hash → SQLite Audit | 已存在目标拒绝/覆盖重试；Control与两Worker重启、MCP新连接；64 MiB传输部分进度暂停/取消/无残留/重试；Revoke后HTTP410 | **完整通过，Exit 0，清理通过**。另通过正式矩阵 `--only L07` 真实运行；TTL 24h GC及Worker直连未验 |
| **E702 / L05 Workspace Wait/Reentry** | MCP SDK → Task/Todo → Pause/Resume → 真Worker tmux执行 → Wait持久化 → Control两次重启 → 3次SDK连接 → Reentry Receipt → 最终审计 | 真180秒detached后两次重启，竞态Claim、Attempt重复拒绝、仅一次终端副作用和Wait恢复 | **完整通过，Exit 0，清理通过**；未实际向ChatGPT Host发消息（模拟Rejected报告），Goal新建未验 |
| **E703 / L03 CLI-Web-Control** | CLI真实执行+Chromium Web Stop/Start → Native Control事件订阅 → MCP Todo/Approval → Rust Worker+SQLite Audit | 第三次不同内容且过期Revision的Todo请求保留CAS冲突判断；执行前Pending Approval在尚无ToolCall Audit行时可经Web批准；真Worker副作用1次；故障RPC恢复、Gap重连、重启与硬刷新均实际验证 | **修复后完整通过，Exit 0、Cleanup完成**：六条阶段独立核对CLI/Web/MCP/SQLite状态。Web真实Chromium另有Approve/Deny专测；L03未包含TUI实机 |
| **E704 / L01/L04 Reverse** | Control真实创建 → Device Code → Rust Worker enroll → WSS → MCP Worker bash_run → SQLite → 停机拒绝 → Rust重连/不重播 → Control删除/补偿 → 同名重建 | 错误Device Code拒绝、新码成功；Worker停机时工具不可用、重连后副作用仍仅1次；Control不对自管理Reverse执行非法Start/Stop，公开Cleanup Debt重试/核对 | **修复后完整通过，Exit 0、Cleanup完成**：删除无旧代Pending债务；同名重建、新凭证Enroll、二次退休闭环通过 |

**四链聚合实际验收4/4通过**：2026-10-20宿主 `node acceptance/run-chain-matrix.mjs --all` 退出0，结果 `ok=true, completed=4, failures=[]`；L07、L05、L03、L01-L04全部独立执行并清理。第七轮初次运行曾只有L07、L05闭环：L03发现Todo访问令牌桶阻断及后续Web执行前Approval入口缺失，L01/L04发现自管理Reverse删除Cleanup Debt断点；上表是修复后的实际复测结论，原始失败证据在对应验收台账保留。手动 `beta-matrix-extended` workflow新增`chains`选项，**不在PR强制门禁，也尚未在GitHub Runner实测**。全部链仅使用独立临时HOME与本机Worker，未触碰生产用户目录。跨机SSH/Podman、真实ChatGPT Host、Goal创建、原生完整TUI和24h TTL GC仍待独立验收。
