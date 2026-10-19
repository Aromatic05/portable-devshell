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

