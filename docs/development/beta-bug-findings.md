# Beta 第三轮缺陷导向测试结果

范围：`portable-devshell 1.0.0-beta.1`，承接 `docs/development/feature-test-matrix.md`。本轮严格区分**真正复现失败**、**组件级复现**、**静态可疑行为**和**已修复/实测通过**。严重度仅表示工程优先级，不自动决定运行阻断、发布门禁或无关 Instance 的可用性。

## A. 实际复现且仍待修复

| Bug ID | 影响链路 | 现象与关键证据 | 复现入口 | 等级 |
|---|---|---|---|---|
| R3-001 | C02/C25 | 配置备份收集任意 `.toml`，恢复 Manifest 却只接受 `[A-Za-z0-9-]+.toml`；一旦故障重启，`operator_notes.toml` 等保留文件导致 `control.configLoadFailed`，阻断配置恢复 | `test/known-bugs/ConfigForeignDocument.test.ts` | P1 |
| R3-002 | C02/C25/L08 | Commit 标记已经删除，后续备份清理局部失败仍进入 Rollback，形成旧全局端口配合新 Instance 列表的混合代配置 | `test/known-bugs/ConfigPostcommitCleanup.test.ts` | P0 |
| R3-003 | C30/L06 | Instance 退休通知进行中 Reload，同哈希新 Runtime 替换旧 Runtime；清理错误作用于新代、遗漏旧代资源 | `test/known-bugs/ExtensionLifecycleRace.test.ts` | P1 |
| R3-004 | C30/L06 | Extension 生命周期回调尚未结束，旧 Runtime 被 Dispose；缺少对应生命周期 Lease | `test/known-bugs/ExtensionLifecycleRace.test.ts` | P1 |
| R3-005 | P04/C30 | Stream 异步获取注册时 Instance 退休，正在 Admission 的旧请求仍可在退休后创建 Stream | `test/known-bugs/ExtensionStreamAdmission.test.ts` | P1 |
| R3-006 | C10/C28 | 同一 Refresh Token 并发请求两次均返回 HTTP 200，两条不同后继令牌及 Access Token 仍有效；未实现原子单次轮换 | `test/known-bugs/OAuthRefreshRace.test.ts` | P1 |
| R3-007 | C14/L05 | 旧 Host Claim 执行无效 `validate` 可恢复当前 Receipt，令合法持有人无法继续 `attempt` | `test/known-bugs/ReentryClaimOwnership.test.ts` | P1 |
| R3-008 | C14/L05 | 错误 Claim 提交 `uncertain`，Receipt 变 `settled` 但 Goal 仍 pending，结算所有权不一致 | `test/known-bugs/ReentryClaimOwnership.test.ts` | P1 |

R3-001/002 源码：`packages/control/src/config/store/index.ts`；R3-003/004：`packages/control/src/extension/host/index.ts`；R3-005：`packages/control/src/extension/api/point/control/Dispatch.ts`；R3-006：`packages/mcp/src/oauth/provider/Adapter.ts` 的消费/查找与令牌轮换并发；R3-007/008：`packages/mcp/src/mcpapp/Reentry.ts` 与 `packages/core/src/instance/mcpapp/Reentry.ts`。

上述六个文件包含共 **9 条预期失败的独立断言**，在普通测试环境重新执行，均因具体业务断言不成立而失败，不是导入错误、Sandbox Socket EPERM 或工具安装问题。复现位于 `test/known-bugs/`，明确不属于默认全绿门禁。

## B. 已修复并完成真实复测

| Bug ID | 影响链路 | 原因与实际表现 | 修复及回归证据 |
|---|---|---|---|
| R3-009 | C17/C18 Worker Terminal | `terminal.attach` 对 `from_seq=u64::MAX` 使用直接 `+1`，在 Debug 构建溢出并使真实 IPC 请求超过 65 秒未回复 | `crates/devshell-worker/src/capability/terminal/mod.rs` 改为饱和加法；`beta_ipc_contract.rs` 最大游标测试复测通过 |
| R3-010 | L06 Testspace | User Namespace 外 UID=1000，内 UID=0；重新计算 XDG Runtime 路径产生不同 Hash，真实 `extension-smoke` 被误拒绝 | Testspace Launcher 传播外部 Runtime UID，`scripts/testspace.test.mjs` 跨进程断言通过；新建独立 Testspace 的 `start → smoke → extension-smoke → mailing-smoke → workflow-smoke → approval-smoke → stop` 全部通过且已清理 |

## C. 组件级红色复现，尚需真实部署交叉证明

| 组 | 现象 | 证据与边界 |
|---|---|---|
| U1 MCP App | 旧 Context 的恢复快照晚到时覆盖新 Context 视图；Action 读取延迟后覆盖同 Context 更高版本 Watch 状态 | `test/known-bugs/ui/McpAppBugs.test.tsx`，React + Stub Host，尚非真实 ChatGPT |
| U2 MCP App | 确认框在 Context 已变更/Revision 已更新后，仍发送旧确认意图 | 同上，交互组件级 |
| U3 Web Config | 后台配置 Revision 更新可覆盖未保存草稿；Store 操作 pending 后按钮视图未同步更新 | `test/known-bugs/ui/WebBugs.test.tsx`，真实 Web View + Stub Domain |
| U4 Web Config / Audit | 保存失败后恢复启动丢失原始磁盘错误；Approval 失败时对话框使用旧 Render Error，显示泛化错误而非实际冲突 | 同上，组件级 |

以上 8 条 UI 断言在独立 Vitest 重演均失败；不将跨 Context ID 人为复用或未纳入真实 Host 的问题直接宣称为生产漏洞。原审查发现的两条 Web Config 跨页面复用假设已通过真实父视图排除，没有列为现存 Bug。

## D. 尚未复现为Bug的风险

- **C04 Provider 状态重建**：`ContainerProvisionExisting.#adopted` 只在当前 Runtime 保存，Runtime 重建时可能把自己曾启动的容器误认成外部运行中容器。需要受控多 Runtime 重建测试明确预期的所有权持久化协议。
- **X08 Recall 投影**：`RecallService.contexts` 合并 Context 历史后输出实例集合，尚需证明部分 Context 记录中的其他 Workspace/Instance 名称是否越出主体可见范围。
- **Windows/真实 SSH-Docker-Podman/真实 Host**：Linux 本地和 Testspace 通过不代表这些平台的运行态通过。参见功能矩阵原有 G05/G08/G25/G26。

## E. 测试方法与可复现门禁

本轮 7 个长任务按模块分别进行源码不变量清单、故障/竞态注入、正常用例与拒绝路径，再提供测试和缺陷报告。新测试覆盖 Extension Points、Context/Auth、Provider/Transport、持久化/Reverse、多个 Builtin Extensions、UI、真实 Worker IPC。

默认回归仍是 `pnpm test:scripts`、`pnpm test:packages`、`cargo test --locked --workspace`、`pnpm typecheck`、`pnpm lint`。**红测属于显式运行的已知缺陷验收集**，不能为实现未修复而改断言，不自动变成全局发布阻断。故障证据来自临时 Workspace、真实子进程 SIGKILL、受控协程屏障和独立 Namespace，无生产实例部署。

UI 专项的真实 ChatGPT Host、SSH/容器跨机和 Windows psmux 仍有待验项目；见 `docs/development/feature-test-matrix.md` 的 G01–G32 及本轮新增缺口。 


## 4. 第四轮新增缺陷与缺口（2026-10-20）

本轮另有 **真实 v0.7.7→1.0.0-beta.1 八场景升级成功、6条真Worker IPC通过、16条MCP/OAuth新集成通过（Memory HTTP）、16条 Comment/Memory 单测加一条真 Worker Mailing IPC通过、10条ToolCall/Audit测试通过、17条Web/TUI新测试通过**。这些通过项不能冲抵下述独立失败证据。

### A. 独立失败复现，仍未修复

| R4 ID | 范围/级别 | 触发、实际结果与不变量 | 版本化失败复现 |
|---|---|---|---|
| R4-01 | Provider实例生命周期；U真实实现+Fake容器 | 已配置、由 DevShell 启动的 stopped-container 处于运行状态后重新构造 `ContainerProvisionExisting`，`#adopted` 失效；重建对象错误拒绝为 `core.providerFailed / unsupportedMode=runningContainer`。真实跨Daemon Podman仍待执行 | `test/known-bugs/ProviderAdoptionRuntime.test.ts` |
| R4-02 | ToolCall公共返回；I真实Audit/Control | 执行器产生一次真实文件副作用后，Outbound Hook 失败；SQLite保留 `executionCompleted=true`，Control普通和Stream RPC错误却丢失 `executionCompleted`、`failureStage`、`callId` 三个结构化字段，上层难以判断禁止重试 | `test/known-bugs/ToolCallAuditBoundary.test.ts`（2条） |
| R4-03 | Approval API生命周期；I | 在初次持久化等待中 `ApprovalService.close()`，关闭后仍可发布新待审批并接受迟到 `approve`；**仅裸Service复现，真实Instance正常关闭有额外Lease/Retire保护，尚未证明真实Instance关闭可触发** | 同上（1条） |
| R4-04 | Comment/Mailing耐久；I真SQLite | 通知持久化后Ack写入失败，再打开Mailing/Comment会生成第二条通知 | `test/known-bugs/CommentMailingDelivery.test.ts`（D1） |
| R4-05 | Mailing作用域；I真SQLite | 同Context连两个Instance且Mail ID相同，实例B的有效通知被实例A的去重错误消费 | 同上（D2） |
| R4-06 | Mailing正文解析；I真磁盘 | 某邮件正文包含后一封邮件的标记，后者接受并排队，但原文未写入Inbox | 同上（D3） |
| R4-07 | Mailing失败隔离；I真磁盘 | 已接受Outbox遭后续变更，单个坏发送者阻止此前pending和其他好发送者继续通知 | 同上（D4） |
| R4-08 | MCP SDK取消审计；I内存HTTP+真OIDC/SQLite | Remote Caller 取消到达执行器，标准 `AbortSignal.throwIfAborted()` 导致Audit `status=failed/error=CONNECTION_CLOSED`，而预期为 `cancelled`；尚未在真实公网TCP/Rust执行器上证明 | `test/known-bugs/McpNativeAbortAudit.test.ts` |
| R4-09 | Web Audit UI；组件I | Audit列表缩至较少页时页码不收缩、较新真实状态被旧详情盖回、两个Instance同ApprovalId发生错误互锁；另有审批错误文案丢失重复证实Round3旧缺陷 | `test/known-bugs/ui/web-round4-repro.config.ts`（4条红） |
| R4-10 | TUI确认Overlay；组件I | 实际TuiKeyDispatcher上的Escape能让进行中的危险操作确认框消失；旧Promise Resolve/Reject可以关闭新Instance确认框或注入前实例错误 | `test/known-bugs/TuiOverlayLifetime.test.ts`（3条红） |

对应主要源码：`packages/core/src/instance/runtime/provision/container/Existing.ts`；`packages/shared/src/execution/toolcall/Route.ts`；`packages/core/src/approval/execution/Service.ts`；`extensions/comment/src/mailing/{Service,Store}.ts`；`packages/mcp/src/protocol/Binding.ts` + `packages/core/src/toolcall/execution/ExecutionTarget.ts`；`packages/web/src/view/page/activity/audit/{Page.tsx,tool/Entry.tsx}` 和 `packages/web/src/state/Store.ts`；`packages/tui/src/interaction/{Input.ts,command/Overlay.ts}`。

### B. 真实E2E失败，不得宣称已通过

**R4-11 — Control重启后Instance删除清理债务无法解除。** 使用全新、隔离的 Testspace Root 真正执行 `pnpm testspace recovery-smoke`，完成262次 Config Revision、Gap/Replay、真实 Worker stop/start、Audit/Terminal Logs/Todo持久化、Control restart和新MCP会话执行。最后删除创建的测试Instance时，配置已提交删除，但 `cleanupPending=true`、`cleanupWarnings` 含 `Worker runtime retirement failed`；公开的 `retryCleanupDebt(instanceName)` 调用后同一旧Generation债务仍为 `pending`，无法在清零要求下同名重建。此失败已在多个独立受控Root复现；每轮 `pnpm testspace stop` 均成功，未触碰共享测试或生产系统。证据入口：`scripts/testspace/TestspaceRecoverySmoke.mjs`，隔离手动 `pnpm testspace recovery-smoke`；后续应从 `WorkerCommandClient.retireRuntime` 返回码及底层stderr定位原因，不为测试全绿直接跳过Debt。

**R4-12 — Reverse WSS压力窗口待判定。** `pnpm stress:transport` 受限systemd cgroup运行，8条Transport/Artifact强压基础用例均通过，包括真实Worker 32MiB数据往返；Reverse Gateway前六轮通过，第七轮新Generation已ready，但旧Token仍可认证断言失败，整套退出1。凭据Store的语义是在 `withAuthenticatedToken` operation完成后才移除旧Token，单独增加的同步屏障测试`TokenActivationBoundaryRound4.test.ts` 两条通过。因此当前只能标记为**ready与凭据提交可见性竞态／压力下时序异常，尚未证明未授权连接永久可用**，不得盲目删除原断言或宣布全绿。

### C. 真实已通过与不能宣称的范围

- v0.7.7 真包到 Beta 升级 8/8，包含Audit/Comment/Context/Agent迁移、失败启动回滚、无效Schema拒绝、三类历史事故；仅 Linux 本地。
- Worker 新增 Linux IPC 6/6；Artifact单元/真实HTTP新用例通过；Comment默认 Package 已接入真 Rust Worker IPC，129/129通过；ToolCall并发/SQLite/回连10条新增通过。
- MCP/OAuth 16条真 SDK+OIDC/SQLite测试通过，但受原Agent沙箱端口限制采用标明的 `ROUND4_MCP_TRANSPORT=memory`，不是公网真实TCP/ChatGPT Host验收；独立外进程签名/JWKS/revoke探针通过。
- Web 新增10条真React渲染、TUI新增7条真Dispatcher通过；未覆盖真正的长连接浏览器与真实终端输入设备。
- 配置混合代、OAuth Refresh Token并发双花、Extension生命周期等第三轮缺陷**没有因增加这些测试而自动修复**。见上文第3轮清单与 `test/known-bugs`。

继续测试时以 `feature-test-matrix.md` 第10节 R401–R420 的未验目标平台和此处独立失败测试为优先级依据；扩充默认单测数量并不能代替真实失败恢复能力。


## 5. 第五轮：真实重启与退休边界、OAuth重放和MCP App恢复（2026-10-20）

**已完成的真实恢复对照**：新独占Linux Testspace按 `pnpm testspace retirement-smoke` 运行三阶段：从未启动实例直接删除、显式停止Worker后删除、Control restart后再次显式停止Worker再删除，三种均返回 `cleanupPending=false`、没有本实例旧代pending债务且允许同名重建（3/3）。所有测试根均已停止和清理。这不代表第四轮“重启后直接删除”已经修复，而是提供明确的可恢复前置条件。

### R5-01：残留PID使已经删除的Instance在重启后反复Cleanup Retry失败

真实Rust Worker的 `retire` 命令在Daemon状态为 `Stale` 时要求先Stop，并以 `has stale daemon state; stop it before retirement` 退出1。`packages/core/src/instance/runtime/provision/Retirement.ts` 将失败归类为Provider错误；`packages/control/src/instance/editor/retirement/Debt.ts` 的默认清理重试不会自动清除此残留状态，跨Control restart也持续保存同一旧Generation Debt。

- **完整本地Control Unix Socket+真实Rust Worker** 独立失败复现：`test/known-bugs/ControlCleanupRetryRound5.test.ts`。
- **Worker命令和协调器一致性**独立失败复现：`test/known-bugs/WorkerRetireStalePidRound5.test.ts`。
- 已验证恢复方式：对已确认身份、仅属于隔离测试的Worker显式Stop后，再走Public Cleanup Retry，旧债清零并允许重用名称。**未建议清除任意运行任务或绕过历史清理栅栏**。

### R5-02：Refresh并发重放未撤销已颁发的Access Token

**真实TCP上的OAuth端点与SQLite/OIDC状态**：同一Refresh Token并发发起两次刷新，一次返回HTTP200、一条返回HTTP400 `invalid_grant`；但胜出者拿到的Access Token仍能调用 `resources/list`（HTTP200，安全断言预期HTTP401）。与第三轮已知“两次均成功”和第四轮Memory HTTP回归应区分。独立预期失败：`test/known-bugs/McpRefreshConcurrentReplayRound5.test.ts`。其余16条真127.0.0.1 HTTP、Bearer/Scope/Context、SSE和路由重启回归通过。

### R5-03：MCP App Context切换未隔离旧Reentry与迟到Snapshot

`packages/mcpapp/src/App.tsx` 的React组件级用例重现：Context A的旧Reentry指令在切换至Context B后可以触发由B发起的Claim；A的迟到Snapshot刷新可以覆盖已恢复的B界面。通过真实React交互的两条红色复现：`test/known-bugs/ui/mcpapp-round5-repro.config.ts`。**只证明前端状态机调度错误，尚未证明服务端允许错误Claim，也未经过真实ChatGPT Host**。本轮默认MCP App新增13条正向渲染测试通过。

### 其余未完结项

本轮增加的WSS凭据提交屏障、16代连续替换和SSE POST重试四条真实网络用例，以及八条Store/Ownership断言均已通过；第四轮Reverse第7轮压力异常不能因此被标记修复或彻底排除。先前的Mailing去重、AbortSignal Audit分类、Provider adopted状态和第三轮BUG也未因新测试自动解决。

本轮变更范围是**测试、故障复现与测试文档**，没有修改生产源码或安装运行实例。所有Known-Bugs均保持显式红测，不属于默认期望通过套件。


## 7. 第六轮：新增三条已证实的缺陷及压力观测修正（2026-10-20）

**R6-01 — 重复callId污染原调用审计身份。** 独立真实Control Target/SQLite/文件副作用用例中，第一调用的文件写入已完成但响应仍在途；第二次使用相同`callId`、不同`ctxId`与`requestId`调用，被调度器正确拒绝。然而持久化Audit保存的是第二调用的身份和`failed`状态，原调用完成记录消失，并发生`Active tool call ... was not found`。这会造成实际执行者的审计归属丢失。复现：`test/known-bugs/ToolCallDuplicateAuditOwnershipRound6.test.ts`，实际退出1。重点调查`packages/core/src/toolcall/execution/ExecutionTarget.ts`记录分配先于Scheduler去重，以及`record/History.ts`的相同ID覆盖。

**R6-02 — 已完成副作用的后置适配错误仍返回可重试。** 本地文件真实写入`committed`后，结果适配Hook抛错；SQLite正确记下`executionCompleted=true`、`failureStage=postExecution`及`failed`，但返回错误的`retryable=true`。若调用方按此标志重试，会有重复副作用风险。复现：`test/known-bugs/ToolCallAdapterRetryAfterCommitRound6.test.ts`，真实文件/SQLite独立退出1。应区分尚未执行与执行后失败，而非一律封锁所有错误。

**R6-03 — Reverse失败候选污染已认证前代可靠会话。** 真实localhost WebSocket中Generation 1握手并成功执行`worker.ping`；Generation 2候选的Worker握手按测试注入失败。旧代再次正常调用时Ingress拒绝其帧为`Stale reverse generation frame`，客户端报告`rpc.resultUncertain`。复现：`test/known-bugs/ReverseCandidateFailurePoisonsPreviousRound6.test.ts`，真实TCP退出1。问题在候选未完成激活时即可改变由descriptor共享的可靠帧水位，候选失败没有恢复前代。应隔离候选Frame状态与已提交Owner。

**R6-04 — Reverse Stress存在已修正的错误观测时序，不是上面R6-03的生产缺陷。** 原集成测试只等Instance snapshot`ready`就断言前代Token已经撤销；实际上`ReverseCredentialStore.withAuthenticatedToken`要在激活后提交持久化，再由Ingress发送`DSR2:ready`。受控cgroup压力初次运行第1轮复现提前观测；测试改为等待`DSR2:ready`，并**保留原旧Token必须拒绝的安全断言**。重跑8/8基础Frame/Worker场景、8/8 Reverse Gateway轮次及真实Rust Reverse载体通过。没有修改生产认证语义。

**未定论**：Control Stream取消探针曾在受限子进程中等待超时，后续清理亦未正常结束；尚不能区分测试时序、收尾资源与实现缺陷，未列为已证实RED。本轮只修改测试/手动CI/文档。前轮已知的OAuth Refresh、Mailing、Context、审批等缺陷未因此自动修复。
