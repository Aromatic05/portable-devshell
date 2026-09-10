# Workspace

Workspace 是 portable-devshell 面向长程 Agent 工作的**交互与恢复层**。它建立在 Context 之上，把 Goal、Todo、Question、Approval、durable Wait 和模型 re-entry 组织成一个可观察、可人工接管的状态机。

它不是一个独立 worker，也不是 ChatGPT 中永久常驻的窗口；服务端状态属于 Context，MCP App 只是该状态的一种呈现和控制界面。

## 组成

```text
Context
  ├── Workspace App presentation
  ├── Goal
  ├── Todo / checkpoint
  ├── Question Wait
  ├── tmux Wait
  ├── Approval
  └── automatic re-entry state
```

Workspace snapshot 是服务端的 authoritative view。UI 只投影它，不自己维护第二套任务真相。

## Bootstrap 与重新呈现

正常 bootstrap 发生在 `environ_info`：

```text
environ_info
  -> prepare environment
  -> bind Context/workspace
  -> issue Workspace App capability
  -> return current Workspace presentation metadata
```

`workspace_open` 仍保留，但职责是**重新呈现**已存在的 Workspace，例如：

* 用户关闭了 App；
* iframe remount 后需要重新挂载；
* 某个需要人类交互的工具明确发现当前 presentation 已失活。

它不应该成为每次 Agent 工作的固定第一步。

## 启用与关闭

Workspace 是 instance 级可关闭子系统，默认启用：

```toml
[workspace]
enabled = false
```

关闭不是简单地从 `tools/list` 隐藏入口。Control 会先执行完整的 Workspace retirement：撤销 App presence/capability、停止 wait recovery、回收 automatic re-entry/Goal continuation claim，并终止仍等待 Workspace 人机交互的状态，然后以 Workspace-disabled endpoint 重新注册该 instance。

这个开关只关闭 Workspace 交互与恢复层。MCP endpoint、Context、Worker、`bash_run`、file/tmux primitive 和跨 instance routing 仍可继续使用。TUI 的 instance Config 页面可以直接切换 `workspace.enabled`；重新设为 `true` 会热恢复 Workspace surface，不要求重启 Worker。

## MCP App 生命周期

Workspace UI 使用官方 MCP Apps SDK，而不是自定义 postMessage bridge。

当前实现的重要约束：

* render resource 使用内容 hash 生成版本化 URI，避免 Host template cache 把旧 HTML 当成新版本；
* stable reader alias 与已发布过的历史 URI 继续可读，保证旧会话升级后仍能 remount；
* App 使用 `snapshot` / `watch` / `reconnect` 一类 app-only helper 获取状态；
* `watch` 基于 instance event sequence，只在当前 Context 的相关事件变化时返回新 snapshot，正常无变化时是 heartbeat，不做固定频率全量 polling；
* app-only 写操作必须携带当前 Context 和隐藏 app capability。

这些 helper 属于 App 协议，不应成为模型主动调用的工具。

## 可见状态优先级

Workspace 视图优先展示需要用户处理的状态，而不是后台噪声：

```text
Question / Approval
        ↓
      Goal
        ↓
Todo / background waits
```

waiting/detached 的 tmux Wait 属于后台状态，不会覆盖正在等待用户回答的 Question 或 Approval。

## Question

`workspace_ask` 用于模型确实需要人类输入时创建 durable Question。

关联优先级：

1. 当前 active/blocked Goal；
2. 当前唯一 `in_progress` Todo；
3. 都没有时，仅归属当前 Context。

Question 需要一个仍活跃的 Workspace presentation。这样模型不会在 UI 已经消失时创建一个无人能够回答的 held call。

如果 Host 取消原始 tool call，Question 可以从 held `waiting` 转成 detached；用户随后回答时仍可通过 durable recovery 恢复模型。

## Goal

Goal 用于描述一个有明确 ordered items 的连续工作目标。它与“执行一条 tool call”不同：Goal 的职责是约束**跨多轮模型工作的推进顺序**。

关键状态包括：

```text
active
blocked
completed
stopped
```

当前 Workspace 会把 Goal 的进度、当前项和下一项投影给模型。continuation 语义要求模型完成当前项后立即进入下一项，而不是把“完成当前 item”解释成可以直接结束整个回合。

Goal 的 pause/resume/stop 由服务端做 revision/ownership 校验，避免旧 UI 或并发 App 操作覆盖更新后的 Goal。

## Todo 与 checkpoint

Todo 是更通用的任务计划和持久状态；Goal 可以与 Todo 共存。

Todo task 使用稳定 `taskId` 和 revision。更新时可以携带：

```text
checkpoint.summary
checkpoint.next
checkpoint.blockers
```

checkpoint 是 model re-entry 的可恢复上下文，不是展示用日志。Workspace 在重新进入模型前可以把最新 snapshot/context 写回 Host，使新的模型回合知道上一轮做到哪里。

## durable Wait

Wait 把“原始 HTTP/tool call 是否还在”与“工作是否仍然有效”分离。

主要来源：

* Question；
* `tmux_run(wait=block)`；
* `tmux_read` 的长等待；
* 其他需要 durable recovery 的交互。

Wait 可以经历：

```text
waiting
  ├── resolved
  ├── detached -> resolved
  └── cancelled / consumed
```

`detached` 不代表 task 失败，只代表原始调用链不再负责等待最终结果。

## tmux 长等待

`tmux_run(wait=block)` 的流程是：

```text
start managed task
  -> create durable Wait immediately
  -> keep current tools/call blocked
  -> task finishes within 180s: return result directly
  -> still running at 180s: detach Wait
  -> background tracker continues
  -> task/timeout/user action resolves Wait
  -> Workspace re-enters model when eligible
```

当前 MCP HTTP transport 使用 request-scoped SSE 和 15 秒 keepalive，因此 180 秒同步窗口可以真实保持同一个 tool call，而不会因为上游 HTTP idle timeout 在约两分钟提前产生 5xx。

`timeout` 是从 task 启动开始计算的总 deadline，可以长于 180 秒；它不会把产品同步窗口自动延长到同样长度。

详见 [tmux 工具](../tools/tmux.md)。

## `Stop waiting` 不等于 `Stop task`

这是 Workspace 最重要的边界之一。

用户选择 `Stop waiting`：

* 同步阶段：原 tool call 返回 `interrupted: true`；
* detached 阶段：停止该 Wait 的后台恢复链并让模型按 Workspace 语义继续；
* **两种情况都不杀 tmux task。**

真正停止 task 需要显式的 tmux task control。

## 自动模型 re-entry

resolved Wait 不会简单地“发一条消息”。服务端需要完成一组 fencing：

1. claim 当前 Context 的 re-entry ownership；
2. 重新验证 Wait 与关联 Goal/Todo 仍然有效；
3. 确认没有新的 model execution 正在占用 Context；
4. 生成 authoritative Workspace snapshot；
5. 更新模型上下文；
6. 发送带持久化 recovery identity 的恢复消息；
7. 成功后 consume/complete Wait；失败则 release claim，允许之后重试。

因此 remount、Control 重启、多 App 并发或消息发送失败不会把同一个 Wait 重复恢复多次。

## 用户优先级

Workspace 的自动恢复必须让位于人类显式操作：

* 用户中断模型后，不应该立即被旧 Goal/Wait 自动唤醒；
* pending Approval / Question 不应被后台 tmux 完成事件覆盖；
* Goal/Todo 已停止或 revision 已变化时，旧 recovery claim 必须失效。

这也是 Context execution state 与 re-entry state 分离的原因。

## 恢复与重启

Control / MCP / iframe 重启后：

* Context 与 durable Wait 从持久化状态恢复；
* 已失去原 held tool call 的 `waiting` Wait 会按 orphaned owner 语义转入可恢复状态，而不是假装旧 HTTP 请求仍存在；
* App 重新读取 authoritative snapshot；
* background tracker 对仍有效的 detached tmux Wait 继续观察。

worker 上的 tmux task 生命周期独立于 Context 和 MCP HTTP 连接，因此 transport 重连不会重启 task。

## 相关文档

* [Context](context.md)
* [MCP](mcp.md)
* [tmux 工具](../tools/tmux.md)
* [系统架构](architecture.md)
