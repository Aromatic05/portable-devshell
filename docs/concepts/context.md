# Context

Context 是 portable-devshell 在 MCP 之上的**应用级连续性对象**。它把一次 Agent 工作过程中需要持续归属的状态绑定在一起：workspace environment、Todo、Goal、Wait、Approval、Comments、审计和自动模型恢复。

Context 不是 MCP transport session，也不是认证凭据。

## 核心模型

每个 Context 都有内部 `ctxId`。服务端子系统只使用这个内部 key：

```text
Context
  ctxId
  principal
  status / expiresAt
  external bindings
  environments[]
    instance
    workspace
    temporaryDirectory
  execution / re-entry state
```

一个 Context 可以同时附着多个 instance；每个 instance 都有自己的 workspace environment。instance 本身不持久化默认 workspace。

## Context selector

instance 的 `[mcp].contextMode` 只决定 **MCP 边界如何找到 Context**，不改变内部模型。

### `explicit`

通用 MCP client 默认使用 `explicit`：

* `environ_info` 创建或恢复 Context，并把 `ctxId` 暴露给调用方；
* 后续需要 Context 的 model-facing 工具显式携带该 `ctxId`；
* Context 仍由服务端校验 principal、状态和 instance attachment。

### `openai-session`

ChatGPT endpoint 可以使用 `openai-session`：

* model-facing tool schema 不暴露 `ctxId`；
* 服务端从请求 metadata 的稳定 Host binding 解析内部 Context；
* 同一个 external binding 始终映射到 portable-devshell 自己的 `ctxId`；
* 如果没有可解析的 binding，会 fail closed，不退回一个隐式随机 Context。

`ctxId` 在该模式仍然存在，只是变成内部状态。Workspace App 的 app-only 调用可以携带 `ctxId` 与隐藏 capability，因为那不是模型参数。

## External binding

External binding 是 Host 身份与内部 Context 的映射，例如 ChatGPT 的稳定 session metadata。它具有三个边界：

1. binding 只用于找到 Context；
2. principal 仍单独参与校验；
3. Todo、Wait、Approval 等内部对象从不直接依赖 Host 专用 ID。

这样 Host 集成可以变化，而不需要把平台专用字段扩散到整个运行时。

2026-07-28 MCP 已移除 protocol session；旧客户端的 `Mcp-Session-Id` 兼容路径即使存在，也与 portable-devshell Context 无关。

## `environ_info`：唯一正常 bootstrap

正常工作流从：

```text
environ_info(workspace=<absolute worker path>)
```

开始。它一次完成：

1. 创建、恢复或续租 Context；
2. 在当前 instance 上 prepare workspace；
3. 建立/更新 environment attachment；
4. 通过 Worker Resource Host 准备并返回 managed Skill collection 路径，同时返回平台、project memory、temporary directory 等环境信息；
5. 启动该 workspace 的 alert lease（如果配置）；
6. 在启用 Workspace MCP App 时附带 Workspace bootstrap metadata。

模型不需要再先执行一个独立 `workspace_open` 才能开始工作。

## Environment attachment

Context 对某个 instance 的 environment 至少记录：

```text
instance
workspace
temporaryDirectory
```

workspace 必须是 **worker 机器上的绝对路径**。

Instance Extension 的 model command
`devshell instance connect <instance> [workspace]` 可以把另一个已就绪 instance 的 workspace
附加到同一个 Context。`ctxId` 由 audited model-command broker 在服务端注入，Extension 不持有该内部 id。之后带 `instance` 路由的工具仍必须经过 Context 对该 instance 的 attachment 校验。

### 切换 workspace

同一个 Context 在同一 instance 上重新调用 `environ_info` 可以切换 workspace，但存在活动工作时会被阻止。当前实现至少会拒绝：

* 旧 workspace 上仍 active/blocked 的 Goal；
* 旧 workspace 上仍有可自动恢复的未完成 Wait。

目的是避免一个仍待恢复的任务在 Context 已指向新项目后继续把模型唤回错误 workspace。

## 生命周期

Context 主要状态为：

```text
active
expired
disabled
```

活动调用会刷新租约。external-bound Context 在普通活动时可以续租同一个内部 Context；显式模式也可以通过 CLI 续租。

Control 会压缩 terminal Context 历史，但不会为了限制历史数量而驱逐 active Context。

CLI 管理入口：

```bash
devshell context list
devshell context messages <instance> [ctxId]
devshell context send <instance> <ctxId> <text>
devshell context disable <ctxId>
devshell context renew <ctxId>
```

`context disable` 会使后续依赖该 Context 的操作失效，并让关联资源按各自生命周期完成清理；它不是“停止所有 tmux task”的快捷键。

## Execution 与自动 re-entry

Context 还维护短生命周期的 execution/re-entry 状态，用来防止 Workspace 在模型已经活跃时又发送一次恢复消息。

典型规则：

* 当前 Context 正在执行 model tool call 时，resolved Wait 不立即重复唤醒模型；
* 自动恢复需要先 claim，再重新验证 Goal/Todo/Wait 是否仍然有效；
* 用户显式接管、暂停或中断时，会改变 re-entry ownership，而不是伪造一个新的 Context。

完整状态机见 [Workspace](workspace.md)。

## 安全边界

`ctxId` 是对象归属 key，不是授权 token。

授权至少还依赖：

* MCP endpoint 的 `none` / `token` / `oauth2` 认证；
* request principal；
* Workspace App 写操作使用的隐藏 capability；
* instance/workspace attachment；
* Worker tool capability / namespace 约束与 approval policy。

不要把“知道一个 ctxId”理解成“拥有该 Context 的全部权限”。

## 相关文档

* [Workspace](workspace.md)
* [MCP](mcp.md)
* [系统架构](architecture.md)
* [配置与运行目录](../operations/configuration.md)
