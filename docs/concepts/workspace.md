# Workspace

Workspace 是 portable-devshell 基于 Context 的交互与恢复层，负责 Goal、Agent Memory、Tool Approval、durable Wait、ToolCall Activity 和自动模型 re-entry。它不是独立 Worker，也不拥有第二套任务状态；服务端的 Context、Task、Approval 和 Audit 才是权威数据来源。

独立 Ask/Question Store 已按产品决策退役，不再提供 `workspace_ask` 或 `mcpapp_ask`。需要人工处理的 Tool Approval 仍通过 Inline Interaction 呈现，Goal、Agent Memory 和后台 Wait 不依赖 Question。

## 组成

```text
Context / Instance authoritative state
  ├── Goal
  ├── Agent Memory (var/agent-work; plans / checkpoint)
  ├── Tool Approval
  ├── durable Wait (tmux task / long read)
  ├── ToolCall Audit / Activity
  └── re-entry ownership
          │
          ▼
     MCP App presentation
       ├── Fullscreen Workspace
       ├── Inline Interaction (Approval / Wait)
       └── per-tool Inline ToolCall
```

MCP App 的 snapshot 按当前 `ctxId` 和 instance 过滤领域状态，并投影 `primary / work / background`、`modelContext` 和 `reentry`；Activity 在打开对应标签时单独读取。UI 不修改 Goal 或 Approval 的权威状态，也不将 iframe 本地缓存作为事实来源。

## Bootstrap 与重新呈现

正常模型调用从 `environ_info` 开始：准备 Worker workspace、建立或续租 Context attachment，并在启用 MCP App 时附加有权限的 presentation metadata。模型无须额外执行 Workspace Open。

`mcpapp_open` 是当前的重新呈现入口：当 Fullscreen Workspace 被关闭或需重新打开时使用，不是每次工作的固定前置步骤。历史 ToolCall Inline 卡片与 Workspace 可以通过对应资源 URI 恢复显示。

## 启用、关闭与权限

新建 version 4 Instance 默认关闭 Workspace：

```toml
[workspace]
enabled = false
inlineToolCalls = false
```

启用后才提供 Workspace 的展示与自动恢复能力。关闭时回收当前 Instance 的 App presence/capability、Wait recovery 和相关 Goal continuation/re-entry 资格；它不停止 Worker、不删除 Context、不关闭 MCP endpoint，也不移除 bash/file/tmux 等基本工具。TUI 的 Instance Config 页面可以修改该设置。

`inlineToolCalls` 默认关闭，只影响普通工具调用的嵌入式结果 UI，**不影响 Fullscreen Workspace、必要的交互 UI 或 Audit**。如需在 Workspace 已启用的 Instance 上展示 Inline，可显式将其设为 `true`；目前仅 `bash_run`、`file_read`、`file_edit`、`tmux_run`、`artifact_viewImage` 会获得 Inline 资源。尤其 `progress_report`、`environ_info`、`tmux_read` 等不会创建额外 iframe。历史 ToolCall 的 UI 资源仍可读取。

App-only 的读写请求必须持有当前 Context 的隐藏能力凭据。知道 `ctxId` 不是授权；审批状态属于 Core，MCP App 只调用经过验证的审批操作。

## MCP App 与 UI 生命周期

MCP App 使用官方 MCP Apps SDK，按用途分三类资源：

- **Fullscreen Workspace**：Overview、Activity；Overview 显示当前 Goal、待审批请求、后台 Wait，Activity 显示审计记录。
- **Inline Interaction**：等待用户处理的 Approval / Wait，不要求打开 Fullscreen。
- **Inline ToolCall**：面向各工具的紧凑结果卡片。展开后可以查看语义化输出；反复 `tmux_read` 的结果在 Activity 中按对应 Task 汇聚。

ToolCall 的完整记录由 Audit 持久化；Activity 在原始 Inline 卡片被 Host 销毁后仍可按需读取输出、图片和 Terminal transcript。普通 ToolCall 的 Inline 输出不依赖 Workspace 的 Live Lease。

资源提供内容哈希 URI 及历史兼容别名，使旧会话在升级与 iframe remount 后仍可读取。建立 MCP App bridge 后，单次工具调用或 Host 消息失败只重试原会话；只有真正的 App 关闭或初次握手失败才重建 SDK 生命周期。

App 从受鉴权的 Live Workspace HTTP route 读取 `snapshot / watch`。Watch 使用 instance event sequence 和相关变化通知，无变化时返回 heartbeat，不在客户端循环全量读取。历史 ToolCall 通过独立的 `timeline` 路由按需加载，Overview 不再重复拉取大量 Audit 数据；图片和终端详情仍在对应卡片展开后读取。

临时 Watch 网络错误只暂停需要最新快照的操作，并保留同一 Context 上次成功读取的快照供用户查看；只有 Context 身份或授权发生变化时才清除原快照。若有多个待审批请求，Workspace 会显示总数并依次呈现待处理项。

## 人工操作与 Action Receipt

UI 通过 app-only `mcpapp_action` 提交 `itemId`、`actionId`、`requestId` 以及需要时的 `expectedRevision`。当前支持：

```text
Approval  approve / deny
Goal      pause / resume / retry / stop
```

服务器执行前重新检查 Context、Workspace、当前对象及 revision。Receipt 用于一次操作的幂等投递与恢复，不能取代领域状态；响应丢失后相同请求不会重复执行 mutation，过期的 UI 动作不能覆盖新的状态。模型侧不应直接调用这些 app-only 写操作。

## Goal

Goal 是当前 Context 跨多轮执行的**最终目标**，而非分步骤任务计划。Goal 只有目标文本（`objective`）、必要的备注（`note`）、Revision 与 `active`、`blocked`、`paused`、`completed`、`stopped` 状态；不会存储 `steps` 或任务项。模型使用 `workspace_goal` 的 `start / get / update / block / resume / finish` 管理目标，`finish` 明确将目标标记为完成；所有计划、步骤、检查点和工作记录均属于绑定的 Agent Memory。用户 Pause/Resume/Stop 与恢复指令通过 Revision 和 ownership fencing 协调。Continuation 只判断未完成 Goal 的恢复资格，不依赖步骤数。正在执行的 ToolCall 会更新活动租约，长调用期间定期续期；确认应用了修改的 `file_edit` 会推进独立的进度纪元，普通读取和心跳不会伪造进展。Memory 仍然是计划和工作记录的权威来源。

## Agent Memory 与工作记录

每个 Context 绑定一个持久化 Memory 目录，位于 Workspace 的 `var/agent-work/<name>/`。模型应尽快使用 `devshell memory init <name>` 新建，或 `devshell memory inherit <name>` 接续工作。首次 `environ_info` 提示绑定方法；若未绑定就开始调用其他工具，Comment Extension 将在首次正常工具调用时以 `auto-<随机后缀>` 创建并绑定 Memory，后续复用而不重复创建。显式 init/inherit 优先于自动分配；自动创建失败不阻断正常工具调用。

计划、任务清单、进度、Checkpoint、决策与 Agent 协作内容由 Memory 文件维护。`progress_report` 负责向用户发送进度消息，不存储计划，也不更改 Goal/Memory 状态。`todo_read`、`todo_write` 和独立 TodoStore 已退役。

## durable Wait 与 tmux 长任务

Wait 将底层 Task 是否仍在运行，与原 MCP `tools/call` 是否仍然保持连接分离：

```text
waiting
  ├── resolved
  ├── detached → resolved
  └── cancelled / consumed
```

主要来源是 `tmux_run(wait=block)`、`tmux_read` 的长等待和其他需要后台恢复的工作。`detached` 不是 Task 失败，且不会自动停止进程。

`tmux_run(wait=block)` 使用最长 180 秒同步等待窗口，HTTP SSE 每 15 秒发送 keepalive。窗口内 Task 完成则在当前工具调用返回结果；窗口结束后仍在运行则转为 durable handoff，Worker 上的 Task 继续运行，后台 tracker 观察最终结果或超时。

`timeout` 是 Task 自身的总 deadline，不因同步窗口缩短而改变。

## Stop waiting 与 Stop task

用户选择 `Stop waiting` 只停止当前等待或其自动恢复链：同步阶段可让 held 调用返回 `interrupted`，detached 阶段撤销相关恢复资格。两者均不杀掉 Worker 上的 tmux Task。

真正结束 Task 需要明确执行 tmux Task control；长时间运行本身不是自动清理 Task 的理由。

## 自动模型 re-entry

resolved Wait 或需要继续的 Goal 通过 `reentry.directives` 暴露恢复资格。App 使用 app-only `mcpapp_reentry` 仲裁：

1. `claim` 取得当前 Context 的 re-entry ownership；
2. `validate` 再次核对 Wait、Goal 和 Context 状态；
3. 当前模型执行仍在进行或存在待决 Approval 时，不抢占用户和模型；
4. 使用服务器生成的 `modelContext` 更新 Host，随后 `attempt`；
5. 调用 Host `sendMessage`，再 `report` accepted/rejected/uncertain；失败时适时 `release`，不盲目重复发送。

因此，iframe remount、旧 Action 回执重试或 Control 重启不应导致同一个来源被重复恢复；用户显式暂停、中断或停止 Goal 或 Wait 时，旧的恢复资格必须失效。

## 恢复与重启

Control/MCP/iframe 重启后，Context、Goal、Agent Memory、durable Wait 与 Audit 从权威持久状态恢复。原 HTTP 请求已消失的 held Wait 需要作为可恢复后台状态处理，而不是假定旧工具调用仍在。Workspace 重新获取 snapshot 后再考虑是否 re-entry。

tmux Task 的生命周期属于 Worker/runtime，不因 MCP HTTP 断连、Context 刷新、Workspace remount 或 Control transport 重连而自动结束。

## 相关文档

- [Context](context.md)
- [MCP](mcp.md)
- [tmux 工具](../tools/tmux.md)
- [系统架构](architecture.md)
