# 进入 RC 前的收口与验证记录

> 更新时间：2026-10-26。当前源码版本为 `1.0.0-beta.3`，尚未创建 RC tag、未执行发布。本文区分本地工作树、已有远端 CI 与当前提交的验证，不把历史成功当作发布证明。

## 当前功能链证据

- **2026-10-26，本地基线提交 `c4ab5cc8`**：在独立临时环境运行 `node acceptance/run-chain-matrix.mjs --all`，汇总 `ok=true`、`completed=4`、`failures=[]`，退出码 0；L07 Artifact、L05 Wait/Reentry、L03 CLI/Web/MCP、L01-L04 Reverse/Provider 生命周期全部完成，fixture 已清理。原始输出保存在本地任务记忆 `var/agent-work/rc-preflight-20261026/chains.log`（不随发行包发布）。
- **2026-10-26，本轮修补后的未提交工作树**：再次运行 `node acceptance/run-chain-matrix.mjs --all`，L07/L05/L03/L01-L04 **四链全部成功、退出码 0**，日志位于 `var/agent-work/rc-preflight-20261026/chains-final.log`。L05 真实跨越 180 秒 Wait handoff、两次 Control 重启和无重复执行；L03 验证多客户端一致、失败恢复与持久化 Audit；L01-L04 验证真 Reverse Worker 停机删除、重连、同名重建、无 Cleanup Debt。临时 fixture 均清理。此结果也不属于尚未生成的 RC 提交或远端 CI。
- **2026-10-25，远端提交 `e2482d25`**：手动 `beta-matrix-extended` 已真正创建 Job；GitHub Actions runs `40196644272`（四链）与 `40196646990`（Testspace）分别完成并成功。它们不是常规 PR 门禁，也不能替代随后提交的 CI。
- **2026-10-25，同一远端提交 `e2482d25`**：主 `ci` run `40196641772` **失败**。Linux x64、Linux arm64、Windows x64/arm64、common-linux-x64 成功；macOS contract arm64、darwin x64/arm64 失败。多条 Worker 和 Client 测试在正常执行 `bash_run` 后返回 `bash.ioFailed`，错误为进程组 `SIGKILL` 的 `EPERM`。此项是明确的 **RC 阻断**，不能用其他平台绿灯抵消。

## 用户交互审查范围

按实际入口检查 CLI、TUI、WebUI、MCP App，包括初次初始化、错误输入、Control 不可用/版本不兼容、配置与实例创建、审批、消息发送、OAuth 会话续期、扩展操作及确认对话框、Workspace 授权过期和工具展示。相关状态须由提交后的对应回归和真实操作证明。

本轮工作树已按下列交互一致性做了代码修正与回归：

- 默认关闭普通 ToolCall 的 Inline UI，且不额外挂载 `environ_info`、`progress_report`、`tmux_read` 等频繁工具 iframe；**Fullscreen Workspace、人工审批和 Audit 不受该选项影响**。
- 有副作用的操作必须明确反馈提交状态和失败，不允许过期的异步结果覆盖其他实例、扩展、Context 或用户后来输入的草稿。
- 区分认证过期、暂时断线和真正空数据；允许恢复时给出可执行操作，而不是不准确的“已连接”“正在重连”或“没有数据”。
- CLI 帮助与本地生命周期管理不能无条件依赖远端 Control 成功协商；初始化生成的用户凭证必须在部分失败时有明确交付路径。

## 本轮工作树验证（尚未提交、尚未运行新的远端 CI）

- `pnpm lint`、`pnpm typecheck`：当前工作树通过，包含源代码、测试类型检查及 21 条 Domain import 规则。
- `pnpm build`：本轮修补后各 packages 与 bundled extensions 的生产构建完成，包括 WebUI、MCP App 资产、CLI/Control 与内建 Extensions；构建器有非阻断的浏览器 externalized module / dynamic import 提示，不等于在真实 Host 中已覆盖所有运行场景。
- CLI/TUI 全部包级测试分别 **89/89、307/307**；WebUI **251/251（19 文件）**；MCP App **89/89（6 文件）**，含本轮新增的迟到回复、草稿保护、Fullscreen 失败/重复请求与授权过期断言。
- ToolCall postExecution 真文件/SQLite 回归 **1/1**，Control 的失败候选 Reverse、Call/CallStream outbound 交付失败、重复 callId 原始归属回归 **4/4**。
- Rust Worker `command_read_4k_window_contract` 真 daemon IPC **4/4**；修改后的组回收、取消、超时等 Linux 单测由修复任务定向运行 7 项通过。Darwin x64/arm64 的 **Unix platform 源码**已分别通过最小交叉类型检查，**不是**完整 Worker 的 macOS 构建或原生行为测试。
- 真实 Chromium WebUI smoke 已在独立浏览器验证页面在线、Audit 刷新后保留、实例 Stop/Start 可见；该验收不替代真实 ChatGPT Host 中的 MCP App 交互。
- Release installer 测试在独立终端等价环境（仅清除 DevShell 工具专属模型上下文）下共 15 项，**13 通过、0 失败、2 项 Windows 原生测试按平台跳过**。Unix 测试明确包含从 Worker shell 自升级的拒绝、正常安装、启动恢复和失败回滚。直接从 DevShell 工具上下文运行安装器时被保护机制拒绝是预期行为，不能拿它模拟普通独立终端。
- 43 份 Markdown 共 194 条本地相对链接无缺失；development version 与 compatibility expiry 检查通过。因全仓 Rust 源码有未格式化的无关文件，且 `crates/psmux` 的部分 `tests-rs` 路径缺失，全仓 `cargo fmt --all -- --check` 无法作为本轮清洁门禁；仅对本轮修改的三个 Rust 文件执行了格式化并独立检查，通过 `git diff --check`。

上述是未提交工作树的本地验证，**不能归属于尚未形成的发布提交**。原始命令输出保存在任务目录 `var/agent-work/rc-preflight-20261026/`。

## 进入 RC 的剩余条件

1. **macOS Worker 必须在真实 macOS Runner 复验**。本轮候选修复对仅剩已退出未 reap 的单一子进程组成员所触发的 Darwin `EPERM` 做严格例外，其余 `EPERM` 仍报错，且保持 leader 在组注销之前不被 reap；但不能用 Linux 单测或精简 Darwin 类型检查冒充原生实跑。
2. **Secret / Audit 隔离仍需安全结论**。当前 `packages/core/src/toolcall/execution/ExecutionTarget.ts` 的 Audit scope 直接使用 inbound Rewrite 之后的 payload，Secret placeholder 可能已展开为真实 env 值，导致 Audit input/inputSummary 持久化真实 Secret。这一问题有源码链路支持，并非已完成回归修复；还需设计避免泄漏的输入记录边界或明确的 RC 处理结论。同时检查 env 轮换后 outbound masking 与后续 Rewrite 的遮蔽顺序。详见 [安全说明](../operations/security.md)。
3. 对本轮交互修复做真实用户端回归抽查，并针对最终**同一提交**运行 lint、typecheck、涉及模块测试、真实四链、完整主 CI 六目标和适用的手动扩展验收。验收以 exit code、测试报告与流水线 Job 为准；不要把历史红测当成当前失败，也不要把另一个提交的成功当成当前成功。
4. 核查安装/升级（包括从自己的 `bash_run`/`tmux_run` 自升级应明确拒绝）、发布资产清单、文档链接、版本及协议契约；保留真实 Docker/Podman 引擎、ChatGPT 公网 OAuth 和未覆盖平台的现场限制说明。
5. 上述发布决定完成且由维护者批准后，**另行**执行版本提升、RC tag 与 Release；此收口过程本身不提升版本、不发布。

历史缺陷发现请参阅 [Beta 缺陷记录](beta-bug-findings.md)；完整测试命令及发布工作流参阅 [验收门禁](acceptance.md)。本文件记录阶段证据，不是发行授权书。
