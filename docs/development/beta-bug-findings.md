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

