# ToolCall Boundary

> 状态：设计已冻结，进入实现阶段。
>
> 本文定义 ToolCall 从外部表示进入可信执行域、再返回外部表示时的统一边界。它与 Transport 一样属于顶层架构，不是 WorkerInstance、MCP 或某一种工具入口的私有实现细节。

## 1. 目标

portable-devshell 目前存在多条工具调用路径：

```text
Worker tool call
Control-owned MCP tool
Extension-originated worker call
trusted internal helper call
```

这些路径对 Approval、Audit、Comment、result/error hint、progress 的处理并不完全一致。新增 ToolCall Boundary 的目标是把所有“从外部 caller 进入 Executor”的调用统一到同一套边界语义中，同时保持 Core authority 与 Extension contribution 的职责分离。

ToolCall Boundary 只解决四件事：

```text
review
approval
audit
rewrite
```

其中：

```text
review       Extension 可以观察并决定外部 ToolCall 是否允许继续
approval     Core authority，处理人工审批
audit        Core authority，记录 ToolCall 生命周期
rewrite      Extension 只对文本叶子做外部表示 <-> 内部表示替换
```

ToolCall Boundary 不把 Tool 的业务语义、Scheduler、Context、Transport 或协议表现层重新包装成新的通用 middleware。

## 2. 顶层位置

ToolCall Boundary 是 Core 的顶层机制。

目标代码结构：

```text
packages/core/src/
└── toolcall/
    ├── Approval.ts
    ├── Context.ts
    ├── Execution.ts
    └── boundary/
        ├── Review.ts
        ├── Rewrite.ts
        └── Sequence.ts
```

不继续保留：

```text
worker/instance/tool/call/boundary/...
```

原因不是单纯减少目录层级，而是 ToolCall Boundary 的语义本来就不属于 WorkerInstance 私有实现。

与现有顶层架构的关系可以概括为：

```text
Core
├── Transport
├── ToolCall
├── Context
└── ...
```

## 3. 外外内内

ToolCall Boundary 固定采用“外外内内”结构。

```text
                         OUTER

inbound
    review             Extension
      ↓
    approval           Core
      ↓
    audit              Core
      ↓
    rewrite            Extension
      ↓

                         INNER
                        execute

      ↑
    rewrite            Extension
      ↑
    audit              Core
      ↑
    review             Extension

outbound
                         OUTER
```

这里的 `audit` 表示 **Core Audit 所观察的表示边界**，不是要求实现成单个前后对称 callback。Audit 可以观察完整生命周期，但持久化的数据必须始终是 outer canonical representation。

三个硬约束：

1. **Review 永远看到 outer representation。**
2. **Audit 永远持久化 outer representation。**
3. **Extension 永远不直接拥有 Approval、Audit 或 Executor authority。**

## 4. Canonical outer representation

Boundary 接收到的 ToolCall 首先形成 canonical outer representation。

实现上这个 canonical representation 必须在进入共享 Boundary 生命周期时**只生成一次快照**：`input` 做深拷贝并冻结，`ToolCallContext` 复制并冻结。后续 Review、Approval、Audit、Scheduler identity、inbound Rewrite 和 Worker RPC invocation 都必须引用这份稳定快照，不能再次读取 caller 持有的可变对象。

它包含调用本身需要的稳定外部语义，例如：

```text
toolName
input
ctxId
workspace
source
extensionId
association
requestId
```

具体字段继续沿用现有 ToolCall 数据模型，不在 Boundary 里建立第二套 ToolCall schema。

Boundary invocation context 另外携带 owning `instance`，用于 host 侧把 review/rewrite 请求路由到正确的 per-instance state。`instance` 是 Boundary context identity，不写回普通 `ToolCallContext`，也不是可被 Rewrite 修改的 payload 字段。

一旦进入 Boundary，同一次调用的 outer representation 不允许被 Review 改写，也不允许 caller 在异步 Review / Approval / queue wait 期间通过原始对象引用改变真正将被执行的调用。

## 5. Review

`toolcall.review` 是 Extension Point。

Review 的职责是：

> 在可信执行域之外观察 canonical outer ToolCall，并返回决定。

### 5.1 Inbound Review

Inbound Review 发生在 Approval 和 Rewrite 之前。

概念结果：

```text
accept
reject
approve
```

含义：

```text
accept     该 reviewer 不阻止调用
reject     该调用不得继续进入执行域
approve    该 reviewer 要求进入 Core Approval
```

`approve` 的含义是“需要审批”，不是“Extension 批准了调用”。真正的审批 authority 始终属于 Core。

多个 reviewer 的决定按语义聚合：

```text
reject > approve > accept
```

注册顺序不得改变最终安全语义。即使未来为了反馈展示需要确定稳定顺序，也不能让顺序改变这个聚合规则。

### 5.2 Outbound Review

Outbound Review 发生在 outbound Rewrite 之后，因此它只能看到已经恢复成 outer representation 的 payload。

它可以产生 Comment、hint 或其他外部反馈，但不得读取 Rewrite 之前的内部 secret-bearing payload。

Review result 的非阻断反馈统一放在 `feedback[]`。Core 对所有 reviewer 的 feedback 按 review invocation 顺序聚合；它不参与 `reject > approve > accept` 的 authority 排序，也不允许修改 ToolCall payload。调用方通过独立 side-channel 消费 feedback，因此 presentation 失败不能反向改变 ToolCall 成功/失败语义。

Outbound Review 仍然不是任意结果 mutation middleware。

### 5.3 Rejection feedback metadata

Review 的安全决定和反馈语义需要分开。

`reject` 的最终 authority 始终属于 Core，因此对外顶层错误固定为：

```text
core.toolCallRejected
```

Reviewer 可以附带一个只用于反馈的 `error.code/details`。Core 不允许它替换顶层错误，而是把它保存为 nested cause。这样 Comment 可以保留：

```text
control.modelStopped
control.modelReplyRequired
control.modelResumed
```

等机器可读反馈，现有 hint resolver 仍可沿 cause chain 生成指导，但 Extension 不能借此伪造 Core authority 或 Audit status。

这里的“注册顺序不得改变最终安全语义”只约束 `reject > approve > accept` 的最终 decision。`reason/error` 是单个最高级 decision 携带的诊断 metadata，第一版不定义多个同级 reviewer 之间的单值合并规则；调用方不得把它当成与注册顺序无关的 authority。需要保留多个 reviewer 的外部反馈时使用 `feedback[]`。

## 6. Approval

Approval 保持 Core authority。

```text
review
  ↓
approval
  ↓
rewrite
```

这个顺序保证 Approval UI 看到的仍是 canonical outer representation。

例如：

```text
curl -H "Token: ${SECRET:GITHUB_TOKEN}" ...
```

Approval 只能看到：

```text
${SECRET:GITHUB_TOKEN}
```

而不能看到 inbound Rewrite 后的真实 token。

Review 返回 `approve` 时只是把调用送入 Core Approval；Extension 本身不能直接 grant approval。

## 7. Audit

Audit 是 Core lifecycle observer，不是 Extension Point。

Audit 必须覆盖：

```text
accepted call
review rejected call
approval denied / expired / cancelled call
queued call
running call
completed call
failed call
```

Boundary 不要求为了 Review 新增一个公开 `requested` status。现有 Audit status 是否需要调整，由实现和持久化模型单独决定，不能为了描述 Boundary 而先扩展状态词汇。

Audit 的核心约束只有一个：

> 持久化的 input / output / error 必须是 outer canonical representation。

因此：

- inbound Rewrite 之前可以记录 input；
- Executor 内部的 secret-bearing input 不得持久化到 Audit；
- result/error 必须经过 outbound Rewrite 后才能作为 Audit payload 持久化；
- Review rejection 也必须留下 Audit lifecycle 记录。

## 8. Rewrite

`toolcall.rewrite` 是 Extension Point。

Rewrite 只允许做 **文本替换**。

Core 负责遍历 ToolCall payload 中的字符串叶子，Extension 只接收字符串位置与字符串内容，并返回替换后的字符串。

这个遍历属于 Boundary 自身的基础设施，不应把 JSON 嵌套深度映射成 JavaScript 调用栈深度。实现使用显式遍历状态；Review 的 canonical clone/freeze 与 Rewrite 都必须能处理深层合法 JSON，而不是依赖递归调用栈。

概念接口：

```text
path + text -> text
```

Rewrite 不允许：

```text
修改 toolName
增加或删除字段
改变 JSON shape
修改 number / boolean / null
修改 ctxId / workspace / authority
把一个 ToolCall 替换成另一个 ToolCall
```

因此 Rewrite 不是 middleware，也不是任意 Json transformer。

适合 Rewrite 的能力包括：

```text
secret placeholder expand / mask
path virtualization
opaque token alias
credential reference
external id <-> internal id
```

### 8.1 Rewrite stack

多个 Rewrite 形成嵌套层次，而不是两套互不相关的 inbound/outbound 顺序。

如果逻辑层次是：

```text
OUTER
  rewrite A
  rewrite B
INNER
```

则：

```text
inbound     A -> B
outbound    B -> A
```

也就是严格的入栈 / 出栈关系。

具体 registration 如何声明这个层次，第一版实现前继续沿用 Extension catalog 的稳定标识，不在本文先冻结 `priority`、`direction` 等尚未确认的 public ABI 字段。

同一次 ToolCall 必须固定它取得的 rewrite registrations 及其 Extension generation lease，直到 outbound 完成后再释放。热重载只影响后续 ToolCall，不能让一次调用的 inbound 使用旧 generation、outbound 使用新 generation，否则即使顺序仍是 `A -> B -> B -> A`，也不再是同一个可逆栈。

## 9. Secret 示例

Secret 是 `toolcall.rewrite` 的第一个真实 consumer。第一版不新增独立 vault；placeholder 直接引用当前 instance 已有的 `env`：

```text
${SECRET:NAME} = current instance env.NAME
```

`instance.env` 仍然是通用 environment map，不因为配置视图会 redaction 就把其中所有 value 都解释成 Secret。只有 ToolCall inbound 中显式写成 `${SECRET:NAME}` 并成功展开的名字，才进入当前 ToolCall 的 Secret mask set。

Outer ToolCall：

```text
curl -H "Token: ${SECRET:GITHUB_TOKEN}" ...
```

Secret Extension 注册：

```text
toolcall.rewrite / secret
```

它不获得 config 或 env resource capability。Control 只在一次 `toolcall.rewrite` invocation 内提供：

```text
secret.environment

inbound  + { names: [...] }
    -> current leaf 中实际引用且存在于当前 instance env snapshot 的条目

outbound + no input
    -> 本次 Boundary lease 中此前成功 resolve 过的条目
```

目标 instance 来自当前 Boundary invocation 的 authoritative context，Extension 不能自行指定。Inbound 允许 Extension 提交 `names`，但 Control 会验证每个 name 的 `${SECRET:NAME}` 确实存在于当前字符串叶；因此 Secret Extension 不能借 rewrite interface 枚举任意 env。

Control 在每个 ToolCall Boundary lease 获取时从 live config 固定一份当前 instance env snapshot。同一调用的 inbound / outbound 始终使用同一份 snapshot；后续 ToolCall 才会看到更新后的 env。因此配置更新不要求重启 Secret Extension，也不会因为调用执行期间配置变化而漏掉已经展开 secret 的 outbound masking。只有 builtin `secret` registration 可以请求该 operation。

Inbound 行为：

```text
${SECRET:NAME}
    -> env.NAME
```

不存在的 `NAME` 直接拒绝本次 ToolCall，不能把 unresolved placeholder 交给 Executor。未被当前字符串引用的普通 env 不会暴露给 Secret Extension，也不会进入 mask set。

Outbound 行为：

- result / error / progress 的所有字符串叶子都经过同一个 Secret Rewrite；
- 只把本次 ToolCall inbound 已经成功展开的 Secret value 恢复成对应 `${SECRET:NAME}`；
- `NO_COLOR=1`、`LANG=C` 等未通过 placeholder 引用的普通 env 不会改写正常输出；
- mask set 中已经存在的 `${SECRET:NAME}` 保持不变，未知 placeholder 不能用来包住并逃逸 raw secret；
- value 按长度从长到短匹配，避免较短 secret 截断较长 secret；
- 多个已引用 env key 具有相同 value 时，用稳定 key 顺序选择一个 canonical placeholder。

完整边界：

```text
outer call
  ↓
inbound review
  sees ${SECRET:GITHUB_TOKEN}
  ↓
approval
  sees ${SECRET:GITHUB_TOKEN}
  ↓
audit
  persists ${SECRET:GITHUB_TOKEN}
  ↓
inbound rewrite
  expands env.GITHUB_TOKEN
  ↓
execute
  sees real token
  ↓
outbound rewrite
  masks token from result/error/progress
  ↓
audit
  persists ${SECRET:GITHUB_TOKEN}
  ↓
outbound review
  sees ${SECRET:GITHUB_TOKEN}
  ↓
model / client
```

因此真实 env value 只存在于 Rewrite 内侧。Review、Approval、Audit 和最终 caller 都只处理 outer representation。

## 10. Scheduler

Scheduler 不是 ToolCall Boundary 的新语义层。

现有 Scheduler 同时负责 admission、pending approval、queue、running 等执行状态，并且 pending approval 会占用已接受容量。因此实现时不能简单把整个 Scheduler 移到 Approval 后面。

允许的实现映射是：

```text
canonical outer ToolCall
  ↓
inbound review
  ↓
Scheduler.reserve
  ↓
Core Approval
  ↓
Scheduler queue / run
  ↓
inbound rewrite
  ↓
execute
```

这里 `Scheduler.reserve` 只是 admission bookkeeping，不改变：

```text
review -> approval -> rewrite -> execute
```

这一条 outer/inner 权限顺序。

Inbound Rewrite 应尽量靠近真正执行点，避免 secret-bearing inner representation 在 approval wait 或 queue wait 中长期存在。

## 11. Tool-owned semantic adaptation

现有工具调用链中存在 `invocationInput`、`transformResult` 等 tool-owned semantic adaptation。

它们不属于 `toolcall.rewrite`。

两者边界固定为：

```text
outer representation
  ↓
inbound rewrite
  ↓
existing tool-owned input adaptation
  ↓
execute
  ↓
existing tool-owned result adaptation
  ↓
outbound rewrite
  ↓
outer representation
```

Rewrite 解决的是外部表示与可信内部表示之间的安全边界；tool-owned adaptation 继续解决具体工具自己的业务语义。

## 12. Result / Error / Progress

Boundary 不能只覆盖最终 result。

所有离开可信执行域、可能被 model/client 看到的 payload 都必须经过 outbound Rewrite：

```text
progress
result
error
```

否则 secret 可以通过 progress 或 error 绕过 masking。

Audit 不要求持久化每一条 progress，但任何向外发送的 progress 都必须先恢复成 outer representation。

需要区分 **Executor outcome** 和 **outbound publication outcome**。如果 Executor 已经完成，但 `transformResult` 或 outbound Rewrite 之后失败，caller 仍必须得到 non-retryable failure，避免把一个已经可能产生副作用的调用当成可安全重试；同时 Audit 需要保留执行事实：

```text
executionCompleted = true
failureStage = postExecution | outboundBoundary
```

因此 `status = failed` 不等价于“Executor 没有执行成功”。调用方判断是否可重试仍以结构化 error 的 `retryable` 为准，不能只根据 Audit status 推断副作用是否发生。

## 13. Exactly once

核心调用约束：

> 一次调用从 outer caller 跨入 Executor，只通过 ToolCall Boundary 一次。

因此需要区分：

```text
external entry
    -> enters Boundary

trusted internal helper
    -> stays inside current Boundary
```

不能因为一个工具内部又调用了另一个 trusted helper，就再次触发：

```text
Approval
Audit
Comment budget
Review
Rewrite stack
```

否则会产生双重审批、双重审计和 secret 重复 expand/mask。

## 14. 统一入口

第一阶段覆盖三类 external entry：

### 14.1 Worker tool call

`ToolCallExecution.call()` 是 Worker-backed ToolCall 的正常入口。它在进入共享 Boundary 生命周期前检查 Worker readiness，真正的 Worker RPC invocation 只作为 inner executor。

### 14.2 Control-owned MCP tool

Control-owned MCP tool 通过 `WorkerInstance.callToolOperation()` 进入同一个 `ToolCallExecution` 生命周期。它复用 Review、Scheduler、Approval、Audit 和 Rewrite，但以 Control operation callback 作为 inner executor，因此不依赖 Worker readiness。

operation callback 接收 inbound Rewrite 后的 input；返回值必须经过 outbound Rewrite 后才能进入 Audit 和 MCP structured result。旧的 audit-only operation path 不再存在。

### 14.3 Extension-originated worker call

Extension capability 调用 Worker tool 时已经携带：

```text
source = extension
extensionId
```

它也必须和其他 external entry 一样只经过一次 Boundary。

## 15. Extension API

新增 ToolCall domain Extension Points：

```text
toolcall.review
toolcall.rewrite
```

public ABI 入口位于：

```text
packages/extension/src/domain/toolcall.ts
```

Control adapter 位于：

```text
packages/control/src/control/extension/toolcall/
├── Binding.ts
├── Point.ts
├── Sandbox.ts
└── interface/
    ├── Comment.ts
    ├── Secret.ts
    └── index.ts
```

根目录三个文件分别承担同一 domain 下的三个正交职责：

```text
Point       Extension Point declaration / validation
Binding     active registrations -> Core Boundary port
Sandbox     sandbox codec
```

`interface/` 只包含 invocation-scoped host interfaces。它们不是新的 Extension Points，也不是 resource capabilities；`Binding` 在单次 Boundary lease 内把 authoritative host state 收窄后注入对应 registration。

不新增：

```text
toolcall.hook
beforeExecute
afterExecute
aroundCall(next)
generic middleware
```

Extension 也不获得：

```text
ApprovalManager
AuditStore
Scheduler
raw Executor
```

## 16. Comment 的位置

Comment 是 ToolCall Boundary 的第一个真实 consumer，不是 Boundary 本身。

当前 `comment` Extension 注册：

```text
toolcall.review / comment
```

Inbound Review 负责：

```text
#stop
#resume
#push
tool-call reply deadline
```

Sandboxed Comment Extension 不直接获得 Control、ConversationStore 或 Audit authority，也不新增 resource capability。Control 只在一次 `toolcall.review` invocation 内提供两个窄 interface：

```text
comment.reviewToolCall
    -> allow | push | stop | resume

comment.feedback
    -> string[]
```

这两个 interface 都不接受 Extension 提供的 instance / ctxId / toolName 参数，而是绑定到当前 Boundary invocation 的 authoritative context；调用结束后 interfacePort 随 invocation id 一起释放。只有 builtin `comment` registration 可以请求这些 operation。

`CommentReview` 自己决定哪些 invocation 适用 Comment 控制语义；当前策略是 inbound `call`、`source=mcp` 且存在 `ctxId`。Control 的 scoped interface 只提供 authoritative Comment capability，不重复判断 direction / kind / source，也不拥有 Comment applicability policy。

实现所有权位于：

```text
extensions/comment/src/
├── builtin/
│   ├── CommentReview.ts
│   ├── devshell-extension.json
│   └── index.ts
├── comment/
├── conversation/
├── hint/
│   ├── Feedback.ts
│   ├── Hint.ts
│   ├── Resolver.ts
│   └── tool/
└── index.ts
```

`hint` 规则也由 Comment package 持有，不再属于 `shared`。Result/error Hint 现在由 Comment outbound Review 通过 `feedback[]` 返回；MCP 与 Control Tool Route 只消费 generic ToolCall feedback，不再直接 import Comment 的 resolver。

Conversation、Comment queue/list、pending reply、preferences、routes 与 instance lifecycle 的 runtime ownership 现在由 `CommentExtension` 持有。Control 只有 composition root `ControlRuntimeFactory` 知道 concrete Comment package；Runtime、Route、ToolCall interface 与 MCP Gateway 只依赖各自的窄 Port。`packages/mcp` 不依赖 Comment package，只消费 ToolCall Boundary feedback 与通用 Context Message gateway contract。

Todo 的 enable/rate-limit/report token policy 与 Comment 是不同 authority，继续保留独立的 Todo-only gate；迁移 Comment 不得把 Todo policy 一起吸入 reviewer。

`environ_info` 与 `environ_remote` 也必须和其他 external entry 一样在任何 touch/prepare/connect 等副作用之前进入统一 ToolCall Boundary。

## 17. 实现阶段

实现按以下顺序进行：

```text
1. 建立 Core ToolCall 顶层目录与 Boundary contract
2. 用测试冻结 Review / Rewrite / Sequence 语义
3. 增加 toolcall.review / toolcall.rewrite Extension ABI
4. 把正常 Worker tool call 接入 Boundary
5. 统一 result / error / progress outbound path
6. 消除 Control-owned MCP tool 的 Boundary bypass
7. 迁移 Comment 为 Boundary 的第一个 review consumer，并迁移 Conversation / Hint 所有权
8. 使用 Secret 验证 rewrite 的 expand / mask 闭环
```

每一步都应保持单独可测试、可提交，不为后续阶段提前增加通用抽象。
