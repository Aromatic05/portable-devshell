# 完整功能链自动化验收（第七轮及 Beta 修复复测）

> 基线：Portable DevShell 1.0.0-beta.1，Linux x64 本地真实 Control/Rust Worker，2026-10-20。本文保留第七轮的故障证据，同时以实际复测退出码标记修复状态。脚本一律创建临时 HOME/Runtime/Workspace，不得操作生产 `~/.devshell` 或现有 Testspace。

## 一、四条链的独立可执行入口

| 主链 | 真实执行边界 | 当前本机 E2E | 仍有缺口 |
|---|---|---|---|
| **L07 Artifact** | 两个本机真 Worker：MCP SDK → Control → Rust bash_run → Artifact Store → Share/HTTP Lease → Control Relay Transfer → 第二 Worker 接收/校验 → 重启恢复 → 64 MiB 取消/重试 → Revoke/GC → 双方 SQLite Audit | **通过，Exit 0，Fixture Cleanup 通过**。传输成功、冲突拒绝、覆盖恢复、重启、64 MiB 部分进度取消后无残留、再传与SHA256确认、HTTP410撤销全部验证 | 真跨机器及 Worker 直连未验；24h TTL 自动GC未验；HTTP分享在本地主机 |
| **L05 Wait/Reentry** | MCP SDK → Todo/Task → Action Pause/Resume → Rust tmux 180秒 Wait → Control/Worker两次重启 → 三次MCP重连 → Reentry Claim/Attempt Receipt → Wait恢复 → Todo完成/副作用去重 → 只读 SQLite Audit | **通过，Exit 0，Fixture Cleanup 通过**；实际 handoff 180066 ms，两次Control重启、一次真实执行、结果与日志持久 | 本链没有真实ChatGPT Host消息投递，使用模拟Rejected Receipt；Goal创建未验 |
| **L03 跨客户端** | CLI + 浏览器 Chromium WebUI + Native Control RPC + MCP SDK + Rust Worker → 事件/Revision/Todo/Approval/Audit | **修复后完整通过，Exit 0，Fixture Cleanup 通过**：六条链均通过；包含Web故障RPC恢复、Todo Revision/CAS、无ToolCall历史行的执行前Web Approval（决定由Web发出且副作用恰好一次）、Retention Gap恢复、Control重启后Web/CLI/SQLite状态一致。另有独立Chromium Approve/Deny专测通过 | TUI真渲染未包含在L03；浏览器和Worker均在同一Linux宿主 |
| **L01/L04 Reverse生命周期** | Control创建自管理Reverse Instance → Device Code → Rust Worker Enroll → 真WSS → MCP ToolCall → 文件副作用/SQLite审计 → Worker停止/离线工具拒绝 → Rust重连/不重播 → Control删除/公开Cleanup Retry → 同名重建 | **修复后完整通过，Exit 0，Fixture Cleanup 通过**：断线恢复不重播副作用；删除完成且无Pending Debt，使用新凭证同名重建、重新Enroll并再次完整退休 | 在localhost真实WSS/Rust Worker上验证，跨主机与真实SSH/Podman、公网OAuth仍待验 |

执行命令：

```bash
# 只查看链路列表，不启动任何进程
node acceptance/run-chain-matrix.mjs --list

# 单独选择一条，可独立重放其全部故障与恢复阶段
node acceptance/run-chain-matrix.mjs --only L07
node acceptance/run-chain-matrix.mjs --only L05
node acceptance/run-chain-matrix.mjs --only L03
node acceptance/run-chain-matrix.mjs --only L01-L04

# 顺序运行四条，不因一条失败跳过其他链；必须以本次退出码为准。
node acceptance/run-chain-matrix.mjs --all
```

调度器为每个子进程设置最长480秒，记录每条链的原始退出码，结果包含 `testedChains`、`completed`、`failures`。只有全部真正完成且没有失败时，整体才通过；空测试集合不能误报成功。命令不接受任意路径作为测试项。对应单测：`scripts/chain-matrix.test.mjs`。

## 二、历史断点与修复后的真实链路

### E7-01：Comment Extension 曾无差别限制有意义的 Todo Access（L03，已修复）

实际跨客户端同一Context完成 `todo_write` 创建及下一次Revision更新后，发送携带过期Revision、但**不同的Todo内容**的真实第三次MCP请求。预期是乐观并发拒绝 `todo.revisionConflict` 并确认原Todo未改变；实际先被 `extensions/comment/src/comment/report/{Service,State,Policy}.ts` 的访问令牌桶拒绝，SDK返回：

```text
todo.invalid / use_other_tools
You have performed too many useless operations. Use other tools.
```

历史原因是固定的 `COMMENT_TODO_ACCESS_BUCKET_CAPACITY=2` 对任意 `todo_read`/`todo_write` 前置消耗，尚未判断更新是否必要。修复提交 `c84131d7` 去掉正常Todo读写的前置预算消耗，同时保留无效操作治理和Revision CAS。复测保留第三次携带旧Revision且内容不同的请求：真实MCP先返回正确Revision冲突，后续Web/CLI读取、硬刷新、审计与持久化一致性全部通过；没有用睡眠或放松断言获取绿灯。

### E7-02：自管理Reverse Worker已停止仍无法完成Control侧删除补偿（L01/L04，已修复）

真实临时 Control+Rust Reverse Worker在所有在线、离线、重新连接与MCP文件副作用断言成功之后，测试使用 `devshell-worker stop --instance <testname>` 停止自管理 Worker。随后 `deleteInstance(name)` 确实提交配置删除，但返回 `cleanupPending=true`，原因是 `Instance ... is self-managed; start it on the remote machine`。公开 `retryCleanupDebt(name)` 后 `listCleanupDebts()` 仍存在同名 `state=pending` 旧Generation。

历史根因位于 `packages/control/src/instance/editor/retirement/Runtime.ts`：Control对已停止的自管理Reverse仍走了不属于它的远端进程Start/Stop路径。提交 `d9f73c82` 修复生命周期所有权和旧Generation债务处理；复测真实Rust Worker停止后，Control删除、公开Cleanup Retry、债务核对、新凭证同名重建和再次退休全部通过，未清空其他旧代或无关债务来制造成功。

### H-Web：执行前审批先于ToolCall审计记录，Audit页面无操作入口（L03，已修复）

E7-01解除后，真实L03在前置 `ApprovalService` 审核阶段再次出现阻断：Approval API和CLI均确认有Pending，Web Audit页面却显示0条ToolCall记录，因此不存在Approve按钮。这不是网络延迟或浏览器未刷新，而是UI把审批入口错误依赖于执行后才会存在的ToolCall历史。提交 `808e1d98` 使用按Instance/Context作用域获取的真实Approval快照，在没有历史审计行时独立显示Pending Approvals并共用页面级确认；已有审计行时不重复渲染。复测完整L03六条链均通过，独立真实Chromium测试也覆盖了Approve与Deny、仅一次副作用及硬刷新后completed审计。

## 三、验收门禁说明

`.github/workflows/beta-matrix-extended.yml` 提供 **手动 `chains`** 工作流选项，预备Rust Worker、安装Chromium，随后运行四条Acceptance链并上传日志。该选项 **仅`workflow_dispatch`**，不进入普通PR测试门禁，尚未在GitHub Actions Runner实测。只在 Linux 主机具备真实loopback sockets、Chromium、tmux、sha256sum和构建完成的Worker时执行；子Agent沙箱因 `listen EPERM` 无法运行不能作为产品错误。

**四链聚合已经真实通过：**2026-10-20在隔离Linux宿主运行 `node acceptance/run-chain-matrix.mjs --all`，退出码为**0**，报告 `FUNCTIONAL_CHAIN_MATRIX {"ok":true,"completed":4,"failures":[],"testedChains":["L07","L05","L03","L01-L04"]}`。L07验证真Worker Artifact取消恢复，L05完成真实180秒Wait及重启恢复，L03完成六段浏览器/CLI/MCP/SQLite一致性验证，L01/L04完成自管理Reverse删除及同名重建；各Fixture均已清理。该结论只覆盖此四条真实本机链，不代表跨机、Windows/Podman或ChatGPT Host已通过。L02、L06、L08仍由既有 `acceptance:mcp`、`testspace extension-smoke` 与 `upgrade-smoke` 支持。

### 安全与状态边界

- 全部新链创建随机临时HOME、Runtime和独占Workspace，均不接触生产用户目录和当前运行实例。
- Artifact取消测试只向通过 `/proc/<pid>/environ` 验证归属的隔离Rust Worker发送 SIGSTOP/SIGCONT，确保其恢复，不对系统全局进程杀戮。
- 每条脚本失败也尝试清理自己创建的资源，失败和未执行的阶段保留非零状态。
- 原 `test/known-bugs` 的大部分红测已经原样保留业务断言并迁至默认包回归；仍在该目录的原生Worker专项和UI单独按其README执行，不能为了门禁绿灯删减断言。
