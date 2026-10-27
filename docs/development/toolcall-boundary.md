# ToolCall Boundary

> 本文按 `1.0.0-rc.1` 候选源码更新；原始审计起点为 `2287310a`（beta.1）。历史缺陷仍保留原因与安全目标，但现行行为和测试路径以最新普通回归为准。标为 **KNOWN BUG / 未解决偏差** 的部分必须与当前源码再次核对，不是目标安全契约。

## 1. 职责与 authority

ToolCall 是共享执行入口，不属于 MCP 或 Worker RPC 的私有包装。Control 的 ToolCall Registry 将 definitions、Review/contributor hooks 和 execute callbacks 安装到各个 Instance；每个 Instance 持有自己的 ToolCall API、hook registry 和 execution target。它与管理 Instance 生命周期的 registry 是不同的组件。

| 所有者 | 当前职责 |
| --- | --- |
| Control ToolCall Registry | 同步现有及新增 Instance 的 definitions/hooks/executors；executor 只安装到具有对应注册 definition 的 Instance |
| Shared Runtime | 生成 callId、入口快照、取得 hook lease、Review、Rewrite、选择 target/executor、释放 lease |
| Core Approval | 通过 Core Review hook 评估策略和等待人工审批；Extension 不能 grant approval |
| Instance execution target | 创建 Audit scope、准备输入、Worker readiness、Scheduler reservation/run、调用 executor、结果 adaptation 和发布 |
| Extension Review/Rewrite | 按声明参与检查或改写；不因此获得 Approval manager、Audit store、Scheduler 或 raw Executor authority |

实现入口：

- [共享 API](../../packages/shared/src/execution/toolcall/Api.ts)、[Runtime](../../packages/shared/src/execution/toolcall/Runtime.ts)；
- [Control Registry](../../packages/control/src/toolcall/Registry.ts)、[Instance ingress](../../packages/core/src/instance/model/Instance.ts)；
- [ExecutionTarget](../../packages/core/src/toolcall/execution/ExecutionTarget.ts)；
- [Extension ABI](../../packages/extension/src/domain/toolcall.ts)、[Control binding](../../packages/control/src/extension/api/point/toolcall/index.ts)。

## 2. 当前 pipeline

正常 `kind=call` 路径如下。箭头表示执行顺序，不表示 Audit、执行和传输之间存在原子提交。

```text
Control ToolCall Registry
  └─ installs definitions / hooks / execute callbacks into each Instance

Instance.toolCallIngress.call → shared ToolCallApi.call
  → callId / input snapshot / context copy / acquire hook lease
  → inbound Review（稳定升序；包括 Core 510-approval 的等待）
  → inbound Rewrite（完整 ToolCallValue；稳定升序）
  → 按改写后的 context.instance 选择 target
    按改写后的 toolName 查找已注册 execute callback
  → target Audit scope / requested（仅 recording=host）
  → invocationInput / Worker readiness（callback executor 不检查 Worker readiness）
  → Scheduler.reserve → queued → reservation.run / running
  → registered execute callback 或 Worker tool RPC
  → transformResult
  → outbound Rewrite → outbound Review → terminal value interpretation
  → terminal Audit（仅 recording=host，尽力记录）
  → 返回 payload 或抛出 error → transport delivery
  → finally release hook lease
```

Progress 在执行期间单独串行经过 outbound Rewrite/Review，再交给 `onProgress`；终态处理会等待已排入的 progress。transport 的发送和关闭仍可能在 target 返回之后失败。

分支不能省略：

- Inbound Review 首次 `reject` 后不运行 inbound Rewrite；原调用交给原 owning target 尝试记录 denied，再抛出 Core rejection。
- Inbound Rewrite 可以把 `kind` 改成非 `call`。此时 shared Runtime 直接运行 outbound pipeline 并解释终值，不进入 target、Scheduler 或 target Audit。
- hook acquisition、inbound Rewrite、target resolution 在 target Audit scope 之前失败时，没有统一的 target Audit 兜底。不能声称每次进入 API 都必有持久记录。
- target 的输入准备、readiness、reserve 失败发生在正常 execution/outbound try 之前；这些错误不能一概声称经过 outbound Rewrite。

## 3. 调用值与快照

Extension 的完整调用值形状如下（类型节选，不是新的 schema）：

```ts
interface ToolCallValue {
    context: {
        instance: string;
        source: "cli" | "extension" | "mcp" | "tui" | "web";
        ctxId?: string;
        operationId?: string;
        requestId?: string;
        workspace?: string;
    };
    kind: "call" | "error" | "progress" | "result";
    payload: ExtensionJsonValue;
    toolName: string;
}
```

入口对 `input` 使用 `snapshotJson` 深拷贝并冻结；context 使用对象展开复制并冻结。每次 Review sequence 又对完整 value 做 JSON 快照，各 reviewer 看到相同的只读值。这不等于后续执行永远引用原始 outer input：Rewrite 返回的新值会成为后续处理的输入。context 的入口复制也不应被描述成所有嵌套 Host 字段都深拷贝。

`context.instance` 是显式路由字段。Rewrite 可改变它，也可修改 `toolName`、`ctxId`、workspace、source、payload shape、非字符串值及 kind。target/executor 的选择在 inbound Rewrite 之后；Runtime 不对改写后的调用重新执行 inbound Review/Approval。Review 检查的是改写前调用，不能据此宣称所有改写后的路由和参数都已经被逐项审批。

Host authority 有专门保护：Control binding 从传给 Extension 的 context 中移除 `principal`、`externalBindings`、`contextMode`、`extensionId`，并在接受 Rewrite 返回值时丢弃同名注入、恢复原值。因此完整值改写不是伪造 OAuth principal、外部 session binding 或 Extension origin 的授权；剩余 Context、workspace 与工具权限仍由相应 Host/工具检查承担。

## 4. Review 与 Core Approval

`toolcall.review` 的返回类型只有：

```ts
interface ToolCallReviewResult {
    readonly decision: "continue" | "reject";
    readonly reason?: string;
    readonly error?: { readonly code: string; readonly details?: ExtensionJsonValue };
}
```

Review 按 `hook → id → owner` 的稳定字符串升序执行，遇到首个 `reject` 即停止；全为 `continue` 才继续。没有 `accept/approve` 决定，也没有 `reject > approve > accept` 聚合或 `feedback[]`。首个 rejection 的 reason/error 受顺序影响。

Core 注册 `hook="510-approval", id="approval"`。它在 inbound call 上调用 Approval service：allow 对应 continue，deny 对应 reject，ask 在 hook 内等待决定后返回。因此 Approval 是 Review sequence 中的一项，不是所有 Extension Review 结束后的独立阶段；排在它之后的 reviewer 尚未运行时，审批可能已经发生。

Approval 看到 inbound Rewrite 前的调用摘要。例如输入包含 `${SECRET:GITHUB_TOKEN}` 时，Secret 尚未展开。审批等待发生在 target 的 Scheduler reservation 之前，不占用这次调用的 Scheduler reservation；Instance ingress 的生命周期 lease 则覆盖整个异步审批和后续执行。

审批 action 有窄例外：MCP `mcpapp_action` 的 approve/deny 只有在存在已验证 Context、pending item 与 ctxId/workspace 匹配时才可避免审批自己的决定。它不是通用的审批绕过入口。

Review rejection 的对外顶层 code 固定为 `core.toolCallRejected`，`retryable=false`。Reviewer 的 `error.code/details` 放入 nested cause，例如 Comment 的 `control.modelStopped`，不能替换 Core 顶层 authority。

Outbound Review 在每条 outbound Rewrite sequence 之后观察当时的值；返回的 reject 不改变已形成的结果，异常被捕获并警告。它没有 payload mutation 返回接口，也没有独立 feedback side-channel。它看到的是 Rewrite 的实际输出，不能无条件称为“已安全脱敏的 outer representation”。

## 5. Rewrite 顺序与 generation

`toolcall.rewrite` 接收 invocation（callId、direction、完整 value），返回完整 `ToolCallValue`。Host 不负责一个通用的“path + text → text”叶子协议；Secret 自己遍历字符串，其限制不能推广为所有 Rewrite 的限制。

Review 和 Rewrite 分别排序，两个方向都正序：

```text
inbound Review:   hook / id / owner 升序
inbound Rewrite:  A → B
outbound Rewrite: A → B
outbound Review:  hook / id / owner 升序
```

没有自动反序出栈，也不保证各 Rewrite 可逆。后一个 hook 消费前一个返回的完整值；outbound 可以改变 kind，终值解释会据此返回 payload 或抛出 error。Progress 被改为其他 kind 时可以影响终值，不能把 Rewrite 理解为无副作用的格式化。

单次调用取得 registrations 的 lease，最终统一释放。但若 Rewrite lease 的 generation 已退休，Control binding 会在尚未开始的 outbound invocation 前重新取得同 id registration，并要求 owner 不变；已开始的 hook 不重放。因此不能承诺同一次调用 inbound/outbound 固定同 generation。

## 6. Scheduler、执行与 adaptation

Scheduler 在 Review（含审批）、inbound Rewrite、target 输入准备/readiness 之后才 reserve。它负责本 target 的容量、排队、运行及取消等状态；secret-bearing 输入可能已在 queue wait 前形成。旧方案中“reserve → Approval → queue → Rewrite”不是当前顺序。

`invocationInput(input, callId, finalValue)` 在 reserve 前将 Rewrite 后输入转换为 inner input。`transformResult(result, callId, presentation?)` 在 executor 返回后、outbound Rewrite 前运行。它们仍是独立的 tool-owned adaptation 接口。

Rewrite 本身也承载业务处理：Core Wait hook 修改 numeric `timeMs`、创建 detach 并改写 handoff 结果；Comment 的 Todo access、advice、delivery 也使用 Rewrite。因此不能继续规定“所有业务语义都在 Rewrite 外”。

Worker-backed calls 通过 invoker 发往 Worker；Control-owned operations 通过 `registerExecute` 注册 callback，同样经过 target Scheduler 和 Audit，不依赖 Worker readiness。[Context Tool runtime](../../packages/control/src/context/tool/Runtime.ts) 将 `environ_info/environ_remote` 的准备行为放在 executor 内，先经过共享 pipeline 再执行 touch/prepare/connect。

Extension-originated Worker 调用也使用共享入口，初始 context 携带 `source=extension` 和 `extensionId`。Host 保留 `extensionId`；`source` 本身仍是公开的可改写字段，不能把两者混为同一保护。

Trusted internal helper 使用 [invokeInternal](../../packages/core/src/toolcall/execution/Tool.ts) 直接进入 invoker，留在已有调用的执行域内，不重新发起 Review/Approval/Audit/Rewrite。这是入口选择原则，不是网络重试、持久化故障或进程故障下的全局 exactly-once 承诺。

## 7. Audit、执行事实与 delivery

Audit 是 Core authority，不是 Extension Point；默认 `recording="host"`。`recording="caller"` 时 target 不承担 host Audit，记录责任属于 caller，不能以此推断 caller 一定成功持久化。

正常 target scope 使用 **inbound Rewrite 后、invocationInput 前** 的 toolName、payload 和 context；`inputSummary` 也从这个 payload 生成。Review rejection 则使用未改写的原始调用。完成记录使用 outbound pipeline 后的结果，错误记录保存 error code，部分 command error 会保存改写后的输出。

当前公开 Audit status：

```text
queued | running | completed | failed | denied | queueTimeout | cancelled
```

`requested()` 是内部记录动作，初始 history status 为 queued，不是公开 `requested` 状态。典型生命周期为：

```text
Review rejection → requested → denied
normal target   → requested → queued → running → completed / failed
queue exit      → queueTimeout / cancelled
pre-run failure → failed（存在 active record 时）
```

这个图描述记录路径，不是完整持久化保证。target 多处通过 `recordAudit` 捕获记录错误、abandon active history 并保留执行结果；`failActive` 也会捕获持久化失败。队列/running event append 另有警告处理。因此返回成功不能证明 Audit 完整，Audit 也不是执行前的 durable commit barrier。

必须区分三个事实：

| 事实 | 当前含义 |
| --- | --- |
| Executor 已返回 | target 将 `executionCompleted=true`；不代表 adaptation、Rewrite 或传输已经完成 |
| caller payload 已形成 | outbound pipeline 和终值解释完成；随后 transport delivery 仍可能失败 |
| Audit 已持久化 | 独立的记录行为；可能部分失败或丢失，与前两者不原子提交 |

`status=failed` 不证明没有副作用；取消也不回滚。反过来，`executionCompleted=false` 也不能证明 executor 失败前没有产生部分副作用。

执行后的错误阶段只有 `postExecution | outboundHook`。Outbound hook delivery failure 返回安全的结构化错误，不回传 raw result，不重跑已经失败的 Rewrite；已完成执行时使用 `core.toolResultDeliveryFailed`，包含 callId、executionCompleted、failureStage，固定 `retryable=false`。

**历史缺陷已纳入回归：postExecution adapter retry。** beta.1 中 `transformResult` 抛错会错误保留原 error 的 `retryable=true`。当前 [ToolCallAdapterRetryAfterCommitRound6](../../packages/core/test/unit/tool/ToolCallAdapterRetryAfterCommitRound6.test.ts) 使用真实写入副作用、适配失败和持久化 Audit 断言 `retryable=false`、`postExecution` 及 callId 归属。客户端仍不能因为失败就自动重放有副作用的调用。

**Audit 与执行仍不原子提交；duplicate callId 归属已有回归。** 尽力记录允许执行成功而缺少完整 Audit，这是与 duplicate callId 身份覆盖不同的问题。原历史覆盖漏洞现在由 [duplicate callId 回归](../../packages/control/test/integration/server/transport/ToolCallDuplicateAuditOwnershipRound6.test.ts) 验证：拒绝并发和历史重复 ID，同时保留原调用的 durable Audit 身份、状态与唯一副作用。

## 8. Secret 的 scoped Rewrite

Secret 同时具有扫描与 Rewrite；两者安全边界不同，扫描详见 [安全文档](../operations/security.md)。Rewrite 注册为 `hook="100-secret-mask", id="secret"`，引用格式为：

```text
${SECRET:NAME} → 当前 invocation 的 context.instance 对应 env.NAME
```

它通过 [readSecretEnvironment](../../packages/extension/src/domain/secret.ts) 使用 `secret.environment`，不是 config/env resource capability。Control 只允许 owner id 为 `secret` 的 Rewrite 使用这个 scoped interface：

| 方向 | 请求 | 返回边界 |
| --- | --- | --- |
| inbound | `{ names: [...] }` | 每个名字必须在当前完整 payload 的某个字符串值中有引用；只返回当前 instance 中存在的条目，并记录成功解析的名字 |
| outbound | 无 input | 只返回本 scope 已成功解析的名字所对应的当前 env 条目 |

接口不接受独立 instance 参数，使用该 hook 输入的 context.instance；但这个 context 可能已被前序 Rewrite 改写，不是最初 instance 的不可变快照。引用检查覆盖整个 payload，不是当前单个叶子，也不扫描对象 key。缺少 env 名字时，Secret expand 会拒绝调用。

scope 保存的是 **used names**。每次 interface 请求都重新读取 live config 并复制当时的 env；没有从 inbound 保存到 outbound 的固定 value snapshot。配置变更或后续 Rewrite 改变 instance 都可能改变 outbound 获取的值。

Secret 自己遍历 payload 的字符串值：inbound expand；outbound 对 result/error/progress 做 mask。只有本调用解析的名字进入集合，普通 `LANG=C`、`NO_COLOR=1` 不会仅因存在于 env 就成为 Secret。非空值按长度降序匹配；相同值按稳定名字选择 canonical placeholder；已知 placeholder 保持不变，未知 placeholder 仍接受 raw value 匹配。

在 env/instance 不变且后续 hook 未重新引入原值的正常例子中：

```text
input             { header: "Token: ${SECRET:GITHUB_TOKEN}" }
Review / Approval 看见 placeholder
Secret inbound    { header: "Token: <env 中的真实值>" }
target Audit input / Scheduler queue / executor 使用改写后输入
executor result   { text: "<同一个真实值>" }
Secret outbound   { text: "${SECRET:GITHUB_TOKEN}" }
后续 outbound hooks / Review / terminal Audit / caller
```

这里的 `<…>` 是说明文字，不是可执行的凭据。

**KNOWN 未解决安全偏差：** target Audit input/inputSummary 可能包含展开后的 Secret，当前没有独立原始 outer-input 记录或统一重新 masking 屏障；不能宣称真实值仅存在于 Rewrite 内侧。env 轮换/删除后，outbound 只读当前值，也可能无法遮蔽 inbound 已展开的旧值。此外 Secret 在 outbound 升序中先运行，后续 hook 新增的数据不会再次经过 Secret。目标仍应是阻止 Secret 进入持久化和模型可见通道；上述路径不是对泄漏的认可，本次也没有进行真实 Secret 泄漏实验。

## 9. Comment 与传输入口

Comment 实现位于 [Extension index](../../extensions/comment/src/index.ts)，由自己的 capability/runtime 承担 Comment queue、conversation、pending reply 等业务。`toolcall-gate` Review 对 inbound call、source=mcp、有 ctxId 的调用实施 stop/resume/push/reply deadline 检查。

Comment 的 `todo-access`、`todo-invalid`、`tool-advice`、`comment-delivery` 等是实际 Rewrite registrations。Advice/delivery 将提示合并到结果 `payload.comment` 数组，结果必须能承载对应 object shape；不是 outbound Review 返回 `feedback[]`。Control 的 Review `requestInterface` 当前一律 unsupported，不存在 `comment.reviewToolCall/comment.feedback` 这两个 Host interface。

Control 外部 tool transport 的 `call` RPC 与 `callStream` stream 都进入共享 ingress：前者不向 pipeline 传 signal/progress，后者传 cancel signal 并发送 progress，最终 close 携带 terminal payload。它们不同于 target→Worker 的 inner RPC，也不同于 target transport 用于跨边界代理 execute/hook callback 的协议。hook delivery 安全错误不能泛化为所有连接中断都有同样的执行证据。

## 10. 核对范围

本页按源码修正现行契约，不是下一阶段实施计划，也未引入历史 deprecated API。可定位的回归证据还包括：

- [Hook 顺序单元测试](../../packages/core/test/unit/tool/Hook.test.ts)：两个方向均为升序；
- [Pipeline 单元测试](../../packages/core/test/unit/tool/Pipeline.test.ts)：Audit 失败保留执行结果；
- [Audit/delivery 边界回归](../../packages/control/test/integration/server/transport/ToolCallDeliveryFailure.test.ts)：call/callStream 在已执行副作用后保留 delivery failure 的执行标记和不可重试语义。

历史发现记录保留原始红测条件；当前测试路径由对应 Domain 的普通回归套件持有。每次发布仍须在同一提交上运行上述断言，不能仅凭测试文件存在就认为已验收。
