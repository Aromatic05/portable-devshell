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

一旦进入 Boundary，同一次调用的 outer representation 不允许被 Review 改写。

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

第一版不把 outbound Review 定义成任意结果 mutation middleware。

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
curl -H "Token: ${SECRET:github}" ...
```

Approval 只能看到：

```text
${SECRET:github}
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

## 9. Secret 示例

Outer ToolCall：

```text
curl -H "Token: ${SECRET:github}" ...
```

完整边界：

```text
outer call
  ↓
inbound review
  sees ${SECRET:github}
  ↓
approval
  sees ${SECRET:github}
  ↓
audit
  persists ${SECRET:github}
  ↓
inbound rewrite
  expands real token
  ↓
execute
  sees real token
  ↓
outbound rewrite
  masks token from result/error/progress
  ↓
audit
  persists masked outer payload
  ↓
outbound review
  sees masked outer payload
  ↓
model / client
```

这条链同时说明为什么 Review 必须在 Rewrite 外面，以及为什么 Audit 不能直接记录 Executor payload。

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

## 14. 当前需要统一的入口

第一阶段实现必须覆盖三类当前路径：

### 14.1 Worker tool call

现有 `WorkerInstanceToolExecution` 是主要调用链，需要成为 Boundary 的正常入口。

### 14.2 Control-owned MCP tool

当前 `auditMcpEndpointTool()` 通过 `worker.auditToolCall(operation)` 直接建立 Audit scope，并绕过正常 Approval / Scheduler / Boundary。

这条路径必须迁移到统一 Boundary，不能继续作为长期旁路。

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
└── Sandbox.ts
```

这三个文件分别承担同一 domain 下的三个正交职责：

```text
Point       Extension Point declaration / validation
Binding     active registrations -> Core Boundary port
Sandbox     sandbox codec
```

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

Comment 是 ToolCall Boundary 的消费者，不是 Boundary 本身。

后续 `comment` Extension 可以使用：

```text
inbound review
    #stop
    #resume
    #push
    tool-call deadline

outbound review
    hint
    report/comment feedback
```

Conversation、Comment queue/list、preference、Context retired、instance deleted 等业务生命周期仍属于 Comment 自己的服务接口，不能强行塞进 `toolcall.review`。

第一阶段先完成 Boundary 与 Extension ABI；Comment 迁移单独进行，不和 Boundary 基础设施混成一个提交。

## 17. 实现阶段

实现按以下顺序进行：

```text
1. 建立 Core ToolCall 顶层目录与 Boundary contract
2. 用测试冻结 Review / Rewrite / Sequence 语义
3. 增加 toolcall.review / toolcall.rewrite Extension ABI
4. 把正常 Worker tool call 接入 Boundary
5. 统一 result / error / progress outbound path
6. 消除 Control-owned MCP tool 的 Boundary bypass
7. 迁移 Comment 为 Boundary 的第一个 review consumer
8. 使用 Secret 验证 rewrite 的 expand / mask 闭环
```

每一步都应保持单独可测试、可提交，不为后续阶段提前增加通用抽象。
