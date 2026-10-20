# 完整功能链自动化验收（第七轮）

> 基线：Portable DevShell 1.0.0-beta.1，Linux x64 本地真 Control/Rust Worker，2026-10-20，提交以本轮实际 HEAD 为准。本页区分“已编写测试”“实机执行通过”“部分通过但链断点失败”。脚本一律创建临时 HOME/Runtime/Workspace，不能操作生产 `~/.devshell` 或现有 Testspace。

## 一、四条链的独立可执行入口

| 主链 | 真实执行边界 | 当前本机 E2E | 仍有缺口 |
|---|---|---|---|
| **L07 Artifact** | 两个本机真 Worker：MCP SDK → Control → Rust bash_run → Artifact Store → Share/HTTP Lease → Control Relay Transfer → 第二 Worker 接收/校验 → 重启恢复 → 64 MiB 取消/重试 → Revoke/GC → 双方 SQLite Audit | **通过，Exit 0，Fixture Cleanup 通过**。传输成功、冲突拒绝、覆盖恢复、重启、64 MiB 部分进度取消后无残留、再传与SHA256确认、HTTP410撤销全部验证 | 真跨机器及 Worker 直连未验；24h TTL 自动GC未验；HTTP分享在本地主机 |
| **L05 Wait/Reentry** | MCP SDK → Todo/Task → Action Pause/Resume → Rust tmux 180秒 Wait → Control/Worker两次重启 → 三次MCP重连 → Reentry Claim/Attempt Receipt → Wait恢复 → Todo完成/副作用去重 → 只读 SQLite Audit | **通过，Exit 0，Fixture Cleanup 通过**；实际 handoff 180066 ms，两次Control重启、一次真实执行、结果与日志持久 | 本链没有真实ChatGPT Host消息投递，使用模拟Rejected Receipt；Goal创建未验 |
| **L03 跨客户端** | CLI + 浏览器 Chromium WebUI + Native Control RPC + MCP SDK + Rust Worker → 事件/Revision/Todo/Approval/Audit | **部分验证，整体Exit 1**：CLI→MCP→Worker文件副作用与原始状态核对通过；Web故障RPC后无副作用、UI错误提示、Stop/Start与独立CLI/Native事件顺序一致性通过 | 第三个MCP `todo_write` 在真正检查CAS之前被 Comment Extension 的固定Token Bucket拒绝（`todo.invalid / use_other_tools`），后续Approval、Retention Gap和重启阶段因此未达；未将其记为绿测。TUI真渲染未验 |
| **L01/L04 Reverse生命周期** | Control创建自管理Reverse Instance → Device Code → Rust Worker Enroll → 真WSS → MCP ToolCall → 文件副作用/SQLite审计 → Worker停止/离线工具拒绝 → Rust重连/不重播 → Control删除/公开Cleanup Retry → 同名重建 | **部分验证，整体Exit 1**：从创建到断线重连全部通过，磁盘副作用只一次；删除已提交配置但 `cleanupPending=true`，公开 `retryCleanupDebt` 仍有旧代Pending债务 | 未通过删除和同名重建闭环；测试只在localhost，跨机器SSH/Podman和公网OAuth仍待验 |

执行命令：

```bash
# 只查看链路列表，不启动任何进程
node acceptance/run-chain-matrix.mjs --list

# 单独选择一条，可独立重放其全部故障与恢复阶段
node acceptance/run-chain-matrix.mjs --only L07
node acceptance/run-chain-matrix.mjs --only L05
node acceptance/run-chain-matrix.mjs --only L03
node acceptance/run-chain-matrix.mjs --only L01-L04

# 顺序运行四条，不因一条失败跳过其他链。当前整体应返回非零。
node acceptance/run-chain-matrix.mjs --all
```

调度器为每个子进程设置最长480秒，记录每条链的原始退出码，结果包含 `testedChains`、`completed`、`failures`。只有全部真正完成且没有失败时，整体才通过；空测试集合不能误报成功。命令不接受任意路径作为测试项。对应单测：`scripts/chain-matrix.test.mjs`。

## 二、发现的两个跨链断点

### E7-01：Comment Extension 无差别限制有意义的 Todo Access（L03）

实际跨客户端同一Context完成 `todo_write` 创建及下一次Revision更新后，发送携带过期Revision、但**不同的Todo内容**的真实第三次MCP请求。预期是乐观并发拒绝 `todo.revisionConflict` 并确认原Todo未改变；实际先被 `extensions/comment/src/comment/report/{Service,State,Policy}.ts` 的访问令牌桶拒绝，SDK返回：

```text
todo.invalid / use_other_tools
You have performed too many useless operations. Use other tools.
```

原因是 `COMMENT_TODO_ACCESS_BUCKET_CAPACITY=2` 和 `COMMENT_TODO_ACCESS_REFILL_INTERVAL_MS=30000`，对任意 `todo_read`/`todo_write` 前置消耗，尚未判断这次更新是否必要。它并未证明CAS本身错误，但会阻断一条正常跨端状态恢复链。**不能为使测试全绿而悄悄睡眠或跳过第三次请求**；原完整链脚本保留为可重复失败验收：`node acceptance/run-cross-client-chain-smoke.mjs`。

### E7-02：自管理Reverse Worker已停止仍无法完成Control侧删除补偿（L01/L04）

真实临时 Control+Rust Reverse Worker在所有在线、离线、重新连接与MCP文件副作用断言成功之后，测试使用 `devshell-worker stop --instance <testname>` 停止自管理 Worker。随后 `deleteInstance(name)` 确实提交配置删除，但返回 `cleanupPending=true`，原因是 `Instance ... is self-managed; start it on the remote machine`。公开 `retryCleanupDebt(name)` 后 `listCleanupDebts()` 仍存在同名 `state=pending` 旧Generation。

源码指向 `packages/control/src/instance/editor/retirement/Runtime.ts`：`assertInstanceDeletable()` 只在 `daemonState=failed|stale|unknown` 时跳过远端退休；对于停止但仍有Descriptor的自管理Reverse仍调用拒绝控制方生命周期的 `ReverseExecution.start/stop`。它不是一条测试假故障；应隔离Control注册表删除和远程自管理进程资源回收职责。测试不擅自废弃Debt或允许同名复用；可重复运行 `node acceptance/run-provider-chain-smoke.mjs`。

## 三、验收门禁说明

`.github/workflows/beta-matrix-extended.yml` 提供 **手动 `chains`** 工作流选项，预备Rust Worker、安装Chromium，随后运行四条Acceptance链并上传日志。该选项 **仅`workflow_dispatch`**，不进入普通PR测试门禁，尚未在GitHub Actions Runner实测。只在 Linux 主机具备真实loopback sockets、Chromium、tmux、sha256sum和构建完成的Worker时执行；子Agent沙箱因 `listen EPERM` 无法运行不能作为产品错误。

当前整套四链仍预期非零，直至上述L03、L01/L04缺陷处理并重新验收；不能把L07、L05的通过外推为8条总链全部通过。L02、L06、L08仍由既有 `acceptance:mcp`、`testspace extension-smoke` 与 `upgrade-smoke` 支持，另有本地Reverse压力与Browser验收。默认包单测不构成全链状态报告。

### 安全与状态边界

- 全部新链创建随机临时HOME、Runtime和独占Workspace，均不接触生产用户目录和当前运行实例。
- Artifact取消测试只向通过 `/proc/<pid>/environ` 验证归属的隔离Rust Worker发送 SIGSTOP/SIGCONT，确保其恢复，不对系统全局进程杀戮。
- 每条脚本失败也尝试清理自己创建的资源，失败和未执行的阶段保留非零状态。
- `test/known-bugs` 中的缺陷回归仍由维护者单独运行，不能为了普通门禁绿灯修改产品或断言。
