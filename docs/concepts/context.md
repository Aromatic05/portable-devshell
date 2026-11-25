# Context

Context 是 portable-devshell 由 Control 管理的**应用级连续性对象**。它把一次 Agent 工作过程中需要持续归属的状态绑定在一起：workspace environment、Goal、Memory、Wait、Approval、Comments、审计和自动模型恢复。

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

一个 Context 可以关联零个或多个 instance；每个 instance 最多有一个当前 environment。`environments[]` 是唯一的当前关联来源，Context 没有 primary instance 或全局 workspace。instance 本身不持久化默认 workspace。

Workspace scope 由 instance 与 Worker canonical workspace path 组成。目录不属于某个 Context；多个 Context 可以共享同一个 scope。

## 实现归属

Context 的权威状态、生命周期、environment 准备和清理集中在 `packages/control/src/context/`，由 Control runtime 创建并共享。MCP、CLI、App 和扩展通过注入能力访问同一份状态；MCP Host 不创建私有 Context Registry。

持久化格式为 v2。启动时仅对已含明确 `environments[]` 的合法 v1 文档执行一次原子升级，移除顶层重复字段；缺少关联或仅有旧 external identity 的记录明确报错且不覆盖原文件。正常运行不合成旧 primary 关联。

## Context selector

MCP URL 决定**是否以及如何找到 Context**：

| 路由 | Context 来源 |
| --- | --- |
| `/<instance>/mcp`、`/<instance>/mcp/openai-session` | 已认证主体 + `openai/session` |
| `/<instance>/mcp/agy-session` | 已认证主体 + `antigravity.google/conversation_id` |
| `/<instance>/mcp/explicit` | `environ_info` 返回 `ctxId`，后续调用显式携带它 |
| `/<instance>/mcp/stateless` | 不创建或查找 Context；每次调用提供 Worker 绝对路径 |

自动会话模式不在模型工具 schema 或模型结果中暴露 `ctxId`。调用缺少对应 metadata 时会提示选择正确入口，不会更换模式或创建无绑定的 Context。OpenAI Workspace App 的私有调用仍可携带内部 `ctxId` 和隐藏 capability。绑定 Context 的模式都会校验 principal、Context 状态和 instance attachment。`stateless` 不做这些 Context 校验，但仍使用该 instance 的 MCP 认证与 Worker 权限。无认证或共享 bearer 不区分共享同一凭据的用户。

## External binding

External binding 是 Host 身份与内部 Context 的映射，例如 ChatGPT 的稳定 session metadata。它具有三个边界：

1. binding 只用于找到 Context；
2. principal 仍单独参与校验；
3. Goal、Wait、Approval 等内部对象从不直接依赖 Host 专用 ID。

这样 Host 集成可以变化，而不需要把平台专用字段扩散到整个运行时。

2026-07-28 MCP 已移除 protocol session；旧客户端的 `Mcp-Session-Id` 兼容路径即使存在，也与 portable-devshell Context 无关。

## `environ_info`：唯一正常 bootstrap

正常工作流从：

```text
environ_info(workspace=<absolute worker path>)
```

开始。每次调用 `environ_info` 都必须传入用户提供的 `workspace`；如果用户还没给出 Worker 上的绝对路径，先询问，再调用。它一次完成：

1. 创建 Context 或恢复其工作区资源；
2. 在当前 instance 上 prepare workspace；
3. 建立/更新 environment attachment；
4. 通过 Worker Resource Host 准备并返回 managed Skill collection 路径，同时返回平台、project memory、temporary directory 等环境信息；
5. 启动该 workspace 的 alert lease（如果配置）；
6. 在启用 Workspace MCP App 时附带 Workspace bootstrap metadata。

模型不需要先执行 `mcpapp_open`；该工具仅用于重新呈现已启用的 Workspace。

## Environment attachment

Context 对某个 instance 的 environment 记录 instance；准备 workspace 后还记录 workspace 与 temporaryDirectory：

```text
instance
workspace
temporaryDirectory
```

workspace 必须是 **worker 机器上的绝对路径**。

跨 instance environment 使用 opaque handle bootstrap。Instance Extension 的 model `list/status`
通过 audited Context projection 返回当前 Context 可见 remote instance 的 handle；随后
`environ_remote(command="attach", handle=..., workspace=...)` 在 Control/MCP 侧直接建立 environment，
不依赖当前入口 Worker 能否执行 shell。handle 只属于当前 Context，不暴露内部 `ctxId` 或 provider
凭据。之后带 `instance` 路由的工具仍必须经过 Context attachment 校验。

`environ_remote(command="mask", handle=...)` 是单调 self-confinement：mask 会撤销已有 remote
environment，并永久拒绝该 Context 后续 discovery、attach 和 routed tool。该状态随 Context
持久化且没有 unmask/clear/reset 操作。模型命令的 `current` 只表示本次调用所在的 instance，不是 Context 的永久身份。已关联的 remote instance 仍保留稳定 handle。

### 切换 workspace

同一个 Context 在同一 instance 上重新调用 `environ_info` 或 remote attach 可以切换 workspace，但两种入口共用切换检查，存在活动工作时会被阻止。当前实现至少会拒绝：

- 旧 workspace 上仍 active/blocked 的 Goal；
- 旧 workspace 上仍有可自动恢复的未完成 Wait。

目的是避免一个仍待恢复的任务在 Context 已指向新项目后继续把模型唤回错误 workspace。

## 生命周期

Context 主要状态为：

```text
active
expired
disabled
```

Instance 删除只解除对应 attachment 并撤销其恢复资格；删除最后一个 attachment 不会 disable Context。`active` 且 `environments=[]` 表示 Context 有效但尚无执行位置，之后可以重新 attach。MCP disconnect 不结束 Context。

Instance 删除先持久化清理债务并撤销正常访问，再解除 Context 关联、释放 alerts 和连接引用，最后销毁资源。解除关联与记录当前 Workspace 的资源清理债务是同一次原子持久化，不能只清理此前已存在的债务。清理失败时保留仅用于清理的 Worker 能力和债务；重启可从债务恢复清理能力，但不会重新注册为可访问的 Instance。

人工检查清理债务使用 `devshell instance cleanup list`，重试使用 `devshell instance cleanup retry <instance>`；重试只恢复清理，不重新注册已删除 instance。

TTL 是 Control 的闲置资源回收依据，不是模型工具的有效期。`expired` 表示资源可以被 GC；它不意味着 Context 身份、workspace 关联或业务状态失效。所有模型工具和 MCP App 动作都会自动刷新活动时间；如果运行时资源已被回收，Control 按原有 Context 身份与 workspace 绑定恢复资源，模型无须显式续期或重试 `environ_info`。`disabled` 仍表示显式终止，不能自动恢复。

GC 结清实例引用与 Alert 等清理债务后，将完整的过期 Context 记录从 `contexts.json` 和运行时 Map 移除。最小的权威绑定（`ctxId`、principal、external bindings、instance/workspace 及 remote mask/handle）保存在同目录的 `contexts.json.identity.sqlite3`，按 `ctxId` 或 Host 会话绑定按需查询并重建；不会在每次工具调用时扫描归档。运行时资源恢复还会重新建立 Worker 引用、临时目录和 Alert lease。

最小身份绑定与可回收的运行时资源生命周期不同：彻底删除绑定本身后，只有旧 `ctxId` 的普通工具请求无法安全推断 principal 或原 workspace。显式 `disable` 保持原有不可恢复语义；Control 只压缩这类终止历史，不把普通 TTL 到期当作终止。

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

- 当前 Context 正在执行 model tool call 时，resolved Wait 不立即重复唤醒模型；
- 自动恢复需要先 claim，再重新验证 Goal/Wait 是否仍然有效；
- 用户显式接管、暂停或中断时，会改变 re-entry ownership，而不是伪造一个新的 Context。

完整状态机见 [Workspace](workspace.md)。

## 安全边界

`ctxId` 是对象归属 key，不是授权 token。

授权至少还依赖：

- MCP endpoint 的 `none` / `token` / `oauth2` 认证；
- request principal；
- Workspace App 写操作使用的隐藏 capability；
- instance/workspace attachment；
- Worker tool capability / namespace 约束与 approval policy。

不要把“知道一个 ctxId”理解成“拥有该 Context 的全部权限”。

## 相关文档

- [Workspace](workspace.md)
- [MCP](mcp.md)
- [系统架构](architecture.md)
- [配置与运行目录](../operations/configuration.md)
