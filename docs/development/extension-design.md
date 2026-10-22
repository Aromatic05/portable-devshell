# Extension 架构与 ABI 设计

> 状态：设计推导与现行实现并存的记录。以下明确写“历史”或“提案”的部分不构成当前可用 API；当前契约以 [Extension ABI](../concepts/extensions.md) 和 HEAD 源码为准。
>
> 已实现 API **5.0.0**、manifest schema **1.1.0**：十二项 capabilities（`artifacts / assets / config.core / context.observe / database / instance.events.publish / instance.manage / instance.observe / processes / toolcall.history / worker.delegate / worker.execute`）；十二个 points（`cli.native-commands / cli.model-commands / control.routes / control.streams / execution.environment / execution.sandbox / mcp.tools / toolcall.review / toolcall.rewrite / web.applications / web.pages / tui.pages`）；generation-owned resources/registrations、static catalog、lazy/eager activation、`activate/deactivate` 与两个精确 terminal notifications。
>
> 历史第一阶段范围见第 21–22 节；`agent.providers`、Extension-owned points、`/agent` 和 `/tools` exports 仍为提案。ToolCall 实际顺序与 KNOWN 安全偏差见 [Extension ABI](../concepts/extensions.md#executionmcp-与-toolcall-points)，不能用下文设计原则代替当前执行保证。

## 1. 设计目标

Extension 系统需要同时满足三类需求：

1. **资源授权**：Extension 可以使用哪些由 Control 管理的资源；
2. **功能扩展**：Extension 可以向哪些宿主 domain 提供实现；
3. **生命周期隔离**：Extension generation 的资源、注册项和 sandbox 必须有统一 ownership。

核心设计不是维护一个不断增长的“Extension 能做什么”枚举，而是建立三个正交概念：

```text
Capabilities
Extension Points
Generation Ownership
```

其中：

```text
Capabilities
    Extension 从宿主获得什么

Extension Points
    Extension 向宿主的某个 domain 提供什么

Generation Ownership
    上述资源和注册项何时存在、何时回收
```

这三个概念不能互相代替。

## 2. 设计原则

### 2.1 同一集合中的名称必须属于同一 domain

一个并列集合必须满足：

- 同一个 domain；
- 同一个抽象层级；
- 同一种语法类别；
- 同一个关系方向。

例如以下历史集合是无效设计：

```text
command
rpc
web
lifecycle
dispose
```

它同时混入用户入口、通信机制、技术媒介、生命周期概念和动作，不能作为 public ABI taxonomy。

同理：

```text
cli
api
ui
close
```

也不是合法的同级集合。CLI 是交互渠道，API 是巨大泛化概念，UI 是表现层，close 是生命周期动作。

### 2.2 Domain 拥有 Extension Point

Extension core 不定义一个全局的功能类型表。

每个宿主 domain 自己定义它允许外部 Extension 实现的 Extension Points：

```text
CLI domain
    owns CLI Extension Points

Web domain
    owns Web Extension Points

Tool domain
    owns Tool Extension Points

Agent domain
    owns Agent Extension Points
```

因此新增一个 domain 能力时，不应修改类似：

```ts
ExtensionActivation {
    command?: ...
    web?: ...
    tool?: ...
    provider?: ...
}
```

而应由对应 domain 新增自己的 Extension Point contract。

### 2.3 Capability 不是 Contribution

Capability 的方向是：

```text
Control -> Extension
```

Extension Point registration 的方向是：

```text
Extension -> Domain
```

因此“我提供 CLI command”不能成为 capability，“我获得 Worker session”也不能成为 Extension Point。

### 2.4 Transport 不进入 public ABI

以下概念属于实现层，不得因为当前实现方式而成为通用 Extension ABI：

```text
RPC
MessagePort
HTTP proxy
WebSocket proxy
worker_threads protocol
child_process IPC
Control route framing
```

Domain contract 描述“提供什么”，runtime 决定“怎么跨 sandbox 调用”。

### 2.5 Lifecycle 不作为通用 hook 垃圾桶

禁止建立类似：

```ts
lifecycle: {
    onStart?
    onStop?
    onReload?
    onInstanceRetire?
    onConfigChange?
}
```

如果一个对象依赖另一个资源的生命周期，应通过 ownership / session closure 表达，而不是全局 lifecycle broadcast。

当前 `contextEnvironmentRetired` 与 `instanceGenerationRetired` 是两个窄化的 terminal notification：前者只描述一个 `Context × Instance` attachment 终态，后者只描述一个 Instance runtime generation 即将被回收。它们用于 Extension-owned state cleanup，不拥有 Worker session、managed process 等 Host-managed resource reclamation。

### 2.6 不为未发布 ABI 保留兼容层

当前 Extension ABI 尚未正式 release，因此迁移到本文模型时应直接删除错误设计，不保留 v2/v3 双轨、旧 capability alias 或旧 activation contribution 兼容逻辑。

## 3. 总体模型

```text
┌────────────────────────────────────────────┐
│ Extension Package                          │
│                                            │
│ identity                                   │
│ entry                                      │
│ hostDependencies (package -> range)        │
│ capabilities                               │
│ extension declarations                     │
└───────────────────┬────────────────────────┘
                    │ load
                    ▼
┌────────────────────────────────────────────┐
│ Extension Generation                       │
│                                            │
│ activation                                 │
│ registrations                              │
│ acquired resources                         │
│ sandbox                                    │
└─────────────┬──────────────────┬───────────┘
              │ acquire          │ register
              ▼                  ▼
┌──────────────────────┐   ┌────────────────────────┐
│ Capabilities         │   │ Extension Points       │
│                      │   │                        │
│ assets / database    │   │ CLI-owned points       │
│ worker.*             │   │ Web-owned points       │
│ instance.* / observe │   │ Execution/TUI points   │
│ config / processes   │   │ Control/ToolCall/MCP    │
└──────────────────────┘   └────────────────────────┘
```

Generation 是 ownership root。

当前正常关闭的分层顺序（fault 路径可能跳过 graceful cleanup）：

```text
generation close
    -> stop accepting and drain invocations
    -> revoke registrations
    -> sandbox.dispose: bounded deactivate, close sessions, terminate sandbox
    -> outer cleanup: close database/config, processes, remaining sessions
    -> remove runtime directory
```

异常 fault 时允许跳过 Extension 自己的 cleanup，但 Control-owned resource 必须仍可强制回收。

## 4. Manifest

Manifest 只描述安装前和 activation 前可知的静态事实。`apiVersion` / `schemaVersion` 只接受 `x.y.z` 字符串，同 major 且不高于 Host；整数版本会被拒绝。`hostDependencies` 是 bare package root → compatible version range 对象（如 `{}`），不是数组。

概念结构：

```text
Extension Manifest
├── identity
├── entry
├── hostDependencies (package root -> version range)
├── capabilities
├── config (optional)
└── extensions
```

### 4.1 `capabilities`

`capabilities` 是唯一 capability / permission grant 字段。

禁止再增加平行字段：

```text
runtimePermissions
permissions
hostCapabilities
sandboxPermissions
privileges
```

### 4.2 `extensions`

`extensions` 表示该 package 对已知 Extension Points 的静态声明。

它不是第二套 capability，也不授予任何资源权限。

概念示例：

```json
{
    "capabilities": ["assets", "worker.execute", "processes"],
    "extensions": {
        "cli.native-commands": [{ "id": "agent", "title": "Agent" }],
        "web.applications": [{ "id": "agent", "title": "Agent" }]
    }
}
```

这里的 point id 由 domain 定义，而不是由 Extension core 维护 enum。

`extensions` 已是当前 manifest 字段：它描述 Extension Point declarations，不描述 capability。

### 4.3 `config`

`config` 可包含两种独立声明：`schema/default` 成对定义 Extension-owned 持久 config，通过 `context.config` 使用；`coreAccess` 定义 Core 配置 path → `read/read-write`，必须同时声明 `config.core` capability，通过 `context.capabilities.configCore` 使用。仅有 coreAccess 不创建 owned config。Host 要求所访问的 Core path 明确 export 相应权限；不能读取其他 Extension 的 owned config。

下面是 owned config 片段，不是完整 manifest：

```json
{
    "config": {
        "default": { "enabled": false },
        "schema": {
            "type": "object",
            "properties": { "enabled": { "type": "boolean" } },
            "required": ["enabled"]
        }
    }
}
```

Control 在静态 catalog publication 时发布 Config domain ownership。Extension state 中的 Config 文件跨普通 remove/reinstall 保留，purge 时随 state 一起删除。Candidate generation 可以读取已有值来验证 schema compatibility；只有当前 published generation 能写，因此 replacement 后旧 generation 无法覆盖新配置。

### 4.4 为什么需要静态 declaration

如果所有 Extension Point 都只能在 `activate()` 后动态发现，则 Control 必须先执行所有 Extension，才能知道：

- CLI 有哪些 command；
- Web 有哪些 application；
- 哪些入口应该展示；
- 哪些 Extension 需要按需 activation。

静态 declaration 允许：

```text
install/load manifest
    -> build catalog
    -> render help/navigation
    -> lazy activate when implementation is needed
```

这与 VS Code contribution points 和 IntelliJ descriptor-based extensions 的经验一致。

### 4.5 declaration 不是 implementation

Manifest 只存可序列化 metadata。

真正 callback / implementation 在 activation 时绑定：

```text
manifest declaration
    identifies registration

activation
    binds implementation to registration
```

Host 必须验证：

- runtime binding 对应已声明 registration；
- registration id 属于当前 Extension namespace；
- point id 已注册且 schema 可识别；
- declaration 与 binding contract 一致。

## 5. Capabilities

### 5.1 定义

Capability 是：

> Extension generation 被 Control 授权取得的一类 host-managed resource authority。

因此 capability 名称必须是同一层级的资源类别名词。

当前 API 5.0.0 capability 集合：

```text
artifacts
assets
config.core
context.observe
database
instance.events.publish
instance.manage
instance.observe
processes
toolcall.history
worker.delegate
worker.execute
```

这些 capability 都是：

> 由宿主管理、由 Extension 获得操作权的一类 runtime resource。

### 5.2 `assets`

`assets` 允许 Extension 管理自己拥有的不可变 asset generations，并通过受控路径投影到 Worker。

它不意味着任意 Control filesystem access，也不把 Asset 内部 storage layout 暴露给 Extension。

同理，Worker projection 即使内部复用 Artifact transfer，也只应向 Extension 返回 projection outcome。Artifact `transferId` 如果没有对应的 Extension-facing query/cancel 语义，就只是 transport implementation identity，不能冻结进 public Asset result；当前 `ExtensionAssetProjectionResult` 只保留 `transferredBytes`。

### 5.3 `worker.execute` / `worker.delegate`

`worker.execute` 允许 Extension 打开受 Control 管理的 Worker sessions，并调用正常 Tool pipeline。

`worker.delegate` 使用同一类受控 Worker session，但 transcript ownership 属于委托 runtime，例如 Agent provider 的内部 subagent。两者是独立 grant，不能通过 `openSession()` 参数临时切换 recording ownership；DevShell 仍保留 approval 等安全边界，但不会把 delegated runtime 自己拥有的内部 tool transcript 重复写入普通 ToolCall history。

Worker session 是 **consumer-neutral capability view**：Control 只提供 canonical Worker tool catalog、routing、authorization、lifecycle 与 invocation，不把某个 consumer 的交互字段或展示策略冻结进该 catalog。具体 consumer 必须在 Control 边界之外自行 projection。例如 Agent Extension 决定哪些 Worker tools 暴露给模型、如何裁剪 model-facing schema 与 result；MCP consumer 则自行增加并剥离 `purpose` / `explanation` / `instance` 等 MCP invocation metadata。两者不得复用彼此 projection 后的 schema。

```text
Worker canonical capabilities
    -> Control Worker session
        -> Agent Extension -> Agent model projection
        -> MCP consumer     -> MCP tool projection
        -> other consumer   -> its own projection
```

Tool description 同样遵循 consumer boundary。Worker catalog 的 description 与 schema property description 只陈述 capability 的执行契约、约束、状态变化和数据语义，不包含“模型何时应该调用另一个工具”之类的 orchestration policy。Agent Extension 在 model projection 中拥有自己的 tool description，并可为关键参数补充模型决策语义；MCP catalog 独立投影面向 ChatGPT/MCP consumer 的 description。Control 只转交 canonical definition，不生成或统一 consumer wording。

它不暴露：

```text
WorkerInstance
provider transport
Worker protocol client
SSH / Docker / Reverse connection
Channel / Frame
raw Worker Service / FrameStream
raw worker RPC
```

当前内部 `WorkerInstance.connectTcp()` / `execProcess()` 是 trusted Host transport consumer，不属于 public Extension Worker session ABI。若未来需要向 Extension 开放远端 byte capability，应先定义独立 domain capability 与 authority，不能直接泄漏 Frame stream/window 生命周期。

### 5.4 `processes`

`processes` 必须表示 Control-managed process，而不是简单打开 Node `child_process` 权限。

目标 ownership：

```text
Extension
    -> Process capability
    -> Control Process Manager
    -> Managed Process
```

Generation fault / close 后，Control 必须能强制清理该 generation 创建的所有 managed processes。

Sandbox 本身仍应拒绝裸 `child_process`，否则 Extension worker 被 terminate 后子进程可以成为孤儿，破坏 generation ownership。

### 5.5 `artifacts`

`artifacts` 允许 Extension 使用 Control-owned Artifact share/transfer 管理能力，包括受控创建、查询、撤销、取消与等待。

它不授予任意文件访问，也不暴露 Artifact service/store。Model command 是否能跨 instance/workspace 操作 Artifact 仍由对应 Extension 的 domain grammar 与 authoritative invocation Context 决定，而不是由 capability grant 自动放行。

### 5.6 Instance authority

`instance.observe`、`instance.manage` 与 `instance.events.publish` 分别拥有只读观察、生命周期 mutation 与 event publication authority。创建 schema/validation、enable/disable/start/stop/delete 只属于 `instance.manage`；snapshot/logs/watchEvents 只属于 `instance.observe`；Extension 发布 host-owned instance event 只通过 `instance.events.publish`。

它们都不暴露 `InstanceRegistry`、Worker transport 或 Control editor service；event watch 复用 Control 的 authoritative runtime subscription owner，而不是让 Extension 自己轮询内部状态。

### 5.7 Runtime context

当前字段结构：

```text
ExtensionContext
├── id / generation / version
├── paths
├── logger
├── capabilities
├── config? (owned schema/default only)
└── register(point, id, binding)
```

其中：

```text
context.capabilities.artifacts
context.capabilities.assets
context.capabilities.configCore
context.capabilities.database
context.capabilities.contextObserve
context.capabilities.instanceEventPublish
context.capabilities.instanceManage
context.capabilities.instanceObserve
context.capabilities.processes
context.capabilities.toolCallHistory
context.capabilities.workerDelegate
context.capabilities.workerExecute
```

必须和 manifest grant 一一对应。

没有声明的 capability 不应以“看起来可用、调用时才失败”的 manager 形式伪装存在。

### 5.8 Capability 不是 OS security permission

Capability 控制 portable-devshell 自己管理的资源，不等价于恶意代码 sandbox policy。

filesystem、network、process identity 等 OS 权限是否隔离，是 sandbox/security 层的另一个问题。

不要把 public capability model 描述成 syscall ACL。

## 6. Extension Point 元模型

### 6.1 定义

Extension Point 是由某个 domain 拥有的开放 contract：

> Domain 声明“外部 Extension 可以在这里提供哪一种实现”。

一个 point 至少需要：

```text
stable point id
declaration schema
binding contract
owner
registration lifecycle rules
```

但不需要一个 central `ExtensionPointKind` enum。

Control 内部可以维护一个 `ExtensionPointRegistry` 来组合当前已知 point definition，但它只是 composition/runtime infrastructure，不是 public ABI taxonomy。每个 definition 由 point owner 提供自己的 declaration parser、binding validator，以及需要时的 binding-resource validator；generic registration/catalog/loader 只按稳定 point id 委托，不 import CLI/Web contract。

### 6.2 Stable identity

当前十二个 point identity 使用稳定 namespaced id，完整清单见本文顶部和[现行 ABI](../concepts/extensions.md#extension-points)。`agent.providers` 与 Tool-domain contribution point 是未来候选，不是已注册 point。

Point id 是协议 identity，不依赖 JavaScript object identity。

这一点非常重要，因为 Extension SDK 可能被 bundle 进 `.dsext`；Host 和 Extension 不能要求共享同一个 JS object instance 才能识别 point。

### 6.3 Registration identity

每个 registration 使用 Extension-local id。

Global identity 由 Host 组合：

```text
<point-id> + <extension-id> + <local-registration-id>
```

Extension 不允许注册到别人的 namespace。

`extension-id` 与各 Extension Point 的 local id 是不同 namespace。CLI 的 native/model command state 彼此独立，也与 builtin command tree 独立。例如 `cli.native-commands/status` 可以 overlay builtin `status`，同一 Extension 还可以同时声明 `cli.model-commands/status`。只有同一个 point 内的 registration id 冲突需要拒绝。

### 6.4 Registration ownership

Runtime registration 默认属于当前 generation：

```text
generation
    owns registration
```

Generation retirement 自动撤销 registration。

Runtime Host 只拥有 registration identity、lazy activation、generation lease 和 acquisition，不解释某个 point 的 binding 业务语义。具体 point owner 在取得 registration lease 后负责校验并调用 binding。例如 `cli.native-commands` / `cli.model-commands` 的 binding invocation 属于 CLI domain，而不是 `ExtensionHost` 的 `dispatchCommand` 一类特殊方法。

同样，manifest declaration 与 activation binding 的校验规则也属于 point owner。Generic runtime 可以要求“声明与 binding 一一对应”和“未知 point 被拒绝”，但不能自己实现 CLI command binding 必须是 function、`web.applications` files source 必须位于 code generation 内这类 domain-specific 规则。

第一版不要求 Extension 自己保存 `Disposable` 并手工清理每个 registration。

只有某个 domain 明确需要“generation 存活期间提前撤销单项 registration”时，才为该 point 增加 scoped handle；不把 `dispose()` 做成所有 point 的通用负担。

### 6.5 Declaration modes

不同 domain 的 Extension Point 可以有不同模式：

1. **declarative-only**：manifest metadata 已经足够，无 runtime callback；
2. **declared + bound**：manifest 声明入口，activation 绑定 handler；
3. **runtime-dynamic**：只有 domain 确实需要动态对象时才允许运行时创建 registration。

默认优先选择前两种。

不能因为少数动态场景，就让所有 point 都退化成 `register(string, any)`。

### 6.6 不提供全局 priority 语义

Core 不定义：

```text
priority
order
before
after
```

这些字段是否存在由 point owner 决定。

CLI command、Web application、Tool provider 的冲突和排序语义不同，不能由 Extension core 发明一套万能规则。

### 6.7 Sandbox transport

Extension Point callback 在 sandbox worker 内执行时，Control 可以内部使用 RPC-style protocol，但这只是 runtime transport。

当前实现将 sandbox registration 的 wire representation 收敛为 opaque JSON descriptor，并用私有 `{ point-id, registration-id, input }` binding invocation bridge 跨 Worker 边界。Generic `ExtensionSandboxWorker` / `ExtensionSandboxHost` / `ExtensionLoader` 不解释 descriptor kind，也不 import CLI/Web point contract；descriptor 编解码、Worker-side invocation 和 Host-side proxy restoration 都由 point owner 的内部 sandbox codec 定义。

Public ABI 只看到：

```text
point declaration
registration binding
invocation context
result contract
```

内部协议可以表示为：

```text
point-id
registration-id
invocation-id
opaque binding descriptor
opaque point-owned input/result payload
```

这些 wire details 不导出到 Extension SDK。内部 transport 可以 generic，但 point codec 不能因此回流成 public generic RPC；`ExtensionRpcHandler`、`extension.call` 或“任意 point payload”都不是 Extension-facing contract。

因此旧的 generic：

```text
ExtensionRpcHandler
activation.rpc
extension.call
```

不应成为 public Extension abstraction。

### 6.8 Invocation-scoped Host interface

Extension Point 的一次 binding invocation 可以由 point owner 注入一个只在本次调用期间存在的 Host interface。它与 capability 和 Extension Point 正交：

```text
Capability
    generation-scoped Host resource authority
    declared by manifest.capabilities

Extension Point
    Extension-provided implementation slot
    declared by manifest.extensions

Invocation-scoped Host interface
    Host state narrowed to one active binding invocation
    not declared in manifest
    not retainable after the invocation lease ends
```

Invocation interface 不能成为绕过 capability model 的通用 service locator。它必须由具体 point/domain owner 定义，只暴露当前 authoritative invocation 已经拥有且被进一步收窄的状态；generic sandbox/runtime 只转发 opaque operation/input，不解释业务语义。

当前真实例子是 toolcall.rewrite 的 secret.environment。Secret Extension 没有 Config/env capability；Control 只在当前 ToolCall rewrite lease 内，根据 authoritative instance 和当前 payload 中实际引用的 Secret placeholder 提供对应 env 条目。Extension 不能自行指定 instance、枚举任意 env，也不能把这个 interface 保存到下一次 ToolCall。

因此 invocation interface 不进入 manifest.capabilities，也不进入 manifest.extensions。如果某项 authority 需要跨 invocation 保留、独立获取或形成 generation-owned resource，它就不再是 invocation interface，必须重新建模为 capability。

## 7. Public SDK 导出策略

### 7.1 不从 root 导出所有 domain API

`@portable-devshell/extension` root 只导出 core ABI：

```text
manifest / module contract
ExtensionContext
capability contracts
generic Extension Point primitives
common JSON / invocation primitives
```

不要让 root 逐渐变成：

```ts
export * from CLI
export * from Web
export * from Agent
export * from Tools
...
```

否则 Extension core 会重新成为所有 domain 的 owner。

### 7.2 推荐 domain subpath

历史建议使用以下 domain subpath；其中 `/agent` 与 `/tools` **尚未 export**，不得作为可运行 import 示例：

```text
@portable-devshell/extension
@portable-devshell/extension/cli
@portable-devshell/extension/web
@portable-devshell/extension/agent
@portable-devshell/extension/tools
```

语义上：

- contract 仍由对应 domain owner 负责；
- `@portable-devshell/extension/*` 只是 public ABI 的 distribution boundary；
- Extension author 不需要依赖完整 `@portable-devshell/cli` / `@portable-devshell/web` runtime package。

### 7.3 为什么不直接依赖 domain runtime package

不建议 Extension 写：

```ts
import ... from "@portable-devshell/cli";
import ... from "@portable-devshell/web";
```

原因：

- CLI package 当前依赖 Control/TUI 等大量 runtime；
- Web package 包含 React/Vite/browser implementation；
- runtime package 不是稳定 Extension ABI；
- 会扩大 dependency closure；
- 容易把 internal class / adapter 泄漏给 Extension。

### 7.4 Domain subpath 的硬约束

每个 domain Extension API module 必须是 leaf contract：

```text
允许：
- point identity
- declaration type
- binding type
- invocation/result DTO
- tiny registration helper

禁止：
- Control class
- React component
- HTTP server implementation
- WorkerInstance
- database/store
- provider transport
- internal route type
```

Domain subpath 只能依赖 core Extension ABI 和必要的稳定数据类型。

### 7.5 不依赖 host module object identity

Domain point definitions 必须可以安全 bundle。

因此：

```ts
import { nativeCommands } from "@portable-devshell/extension/cli";
```

得到的 runtime descriptor 最终依靠稳定 point id 识别，而不是：

```ts
hostPoint === extensionBundledPoint;
```

这样的 object identity。

这允许 `.dsext` 自包含 SDK helper，而不需要通过 `hostDependencies` 暴露 `@portable-devshell/*` internal packages。

当前 Control composition 对 host point-definition registry 与 sandbox point-codec registry 做 fail-fast parity 校验：两边必须拥有完全相同的稳定 point id 集合。这个检查的目的只是防止私有实现漂移，例如新增 `foo.bar` declaration/binding contract 却忘记补 sandbox descriptor/invocation codec；它不能演变成 generic public point catalog 或新的 Extension core taxonomy。

## 8. CLI Domain

### 8.1 两个独立的 command state

CLI public ABI 不再把人类本地 CLI 与 model-facing command projection 塞进同一个 point。自 API v4 起明确拆成：

```text
cli.native-commands
cli.model-commands
```

它们都不是 capability，并且拥有独立 registration/catalog/resolution state。

`cli.native-commands` 面向 native CLI。它允许与 builtin command root 同名，并采用 overlay resolution：

```text
native argv
    -> enabled native Extension command
    -> builtin command fallback
    -> not found
```

因此 Extension 可以增强 `instance`、`status` 等原生命令，同时 builtin tree 继续作为 bootstrap / recovery baseline。

`cli.model-commands` 面向受限 model command state：

```text
model argv
    -> ACL-filtered model Extension command
    -> not found
```

这里**永远没有 builtin/native fallback**。Model resolver 不应依赖 builtin parser，也不应通过“先查 model、失败再执行 native CLI”实现。这是 command architecture 与 authority boundary 的共同不变量。

### 8.2 静态 declaration 与 discovery

两个 point 共用 declarative metadata shape：

```text
local id
title / summary
usage shape
possibly subcommand metadata
```

具体字段属于 CLI domain，不进入 Extension core。Control 在 activation 前即可分别建立 native/model static catalog、检测同一 point 内冲突，并知道哪个 generation 需要 lazy activation。

Native discovery 只投影 `cli.native-commands` presentation metadata；本地 CLI 在 builtin parser 之前用它判断 overlay。`devshell <native-command> --help` 因此可以不 activation Extension。Model discovery 只投影 `cli.model-commands`，不能混入 native/builtin entries。

Declaration schema parser 属于 CLI host/domain validation implementation，而不是 Extension author API。`@portable-devshell/extension/cli` 只导出 `nativeCommands / modelCommands` descriptors 与 declaration/binding/context/result types。

不同 command state 可以拥有相同 local id：`cli.native-commands/status` 与 `cli.model-commands/status` 不冲突；native `status` 与 builtin `status` 也不冲突。只有同一个 Extension Point 内两个 Extensions 争用同一 registration id 才是 static conflict。

### 8.3 Runtime binding

Runtime binding 仍只负责执行：

```text
argv + state-specific invocation context
    -> Extension command implementation
    -> CLI result
```

不要重新暴露 generic `extension.call` 或把 `argv -> JSON` 提升成 Extension core RPC。raw argv 是 CLI domain contract。

Native invocation 当前通过 CLI-owned Control route 获得 generation lease并调用 `CliNativeCommandBinding`。Model invocation 已由 restricted devshell broker 进入 model resolver；它不经过 native route，也不能触发 builtin fallback。

模型在 MCP `bash_run` / managed `tmux_run` 中看到的 `devshell` 不是 builtin Control CLI，而是 Worker runtime 注入的 executable shim。实现使用 executable/PATH resolution interception，而不是 Bash command-string parsing，因此 shell 本身继续负责 argv、pipe、redirect、substitution 等语义。shim 只连 Worker local broker；Worker 再通过既有 notification/control RPC 把 model command invocation 流式桥接到 Control。

Control authority 不来自 Worker 自报 Context。每个 model invocation 必须与 authoritative audit ToolCall 的 `callId / source=mcp / ctxId / workspace` 一致；bash invocation 还要求 parent `bash_run` active，tmux invocation 则要求 active parent 或已完成 `tmux_run` 的 audited `task.id` 与 shim `taskId` 一致。Context 随后通过 MCP Context authority 再按 instance/workspace 校验。任何 mismatch 是 Worker protocol-integrity fault，而不是“换一个 ctxId 再试”。

### 8.4 Invocation contexts

两个 state 不共享一个“audience flag”式 context：

```text
CliNativeCommandInvocationContext
    io?
    localOwner
    requestId
    signal
    workingDirectory?

CliModelCommandInvocationContext
    ctxId?
    context (instanceReference)
    instance
    io?
    requestId
    signal
    workspace
```

local-owner CLI 的 working directory 是 native invocation domain 语义，应明确传递。Extension 不得读取 Control daemon 自己的 `process.cwd()` 猜调用者目录。

Model context 不暴露 `localOwner` 或 Control-host cwd，但当前公开可选 `ctxId` 与只读 `context`、`instance`、`workspace`。这些值由 Broker 在校验父 ToolCall provenance 和 Context attachment 后注入，模型 argv 不能选择其 authority；`io` 支持流式输出，Broker 不支持交互输入。

### 8.5 不应导出的内容

CLI Extension API 不应导出：

```text
CliMain
CliRuntimeAdapter
Control client
TUI renderer
exit mapping internals
HTTP route
```

只导出 command point contract。

### 8.6 未来候选 point

未来只有出现真实需求后再考虑：

```text
cli.completions
```

不要预先制造：

```text
cli.renderers
cli.parsers
cli.middleware
```

这类没有实际 Extension 用例的 public ABI。

## 9. Web Domain

### 9.1 第一批 Extension Point：`web.applications`

当前 Agent 需要在 Control Web host 下提供完整 browser application，因此 Web 是第二个必须落地的 point owner。

`web.applications` 表示：

> Extension 提供一个可由 portable-devshell Web host 挂载和认证的 browser application。

这个概念比旧的 `web` contribution 更明确。

### 9.2 Host 拥有 mount 和 authentication

Extension 不拥有最终公网 route。

Web domain 应负责：

```text
mount path allocation
authentication/session policy
same-origin policy
security headers
HTTP/WebSocket transport
lease lifetime
```

Extension 只提供 application 所需的内容来源和 point-specific metadata。

### 9.3 不把 proxy 当成 Extension domain

旧模型：

```text
web.kind = static | proxy
resolveUpstream()
```

把 Web host 的 serving implementation 泄漏给 Extension。

目标模型只表达：

> 这是一个 Web application；它需要什么 application source。

具体 contract 可以允许不同 application source，但名称必须在 Web domain 内重新审查，不能把 `static` / `proxy` 直接提升为 Extension core taxonomy。

### 9.4 Static metadata

> 实现状态：已落地。Web domain 从 static catalog 投影 `web.applications` declaration，主 WebUI 在 Extension 未 activation 时即可生成 application navigation entry。Navigation 直接链接到 Web host 已有的 `./extensions/<application-id>/` mount；它不是主 SPA hash route，也没有新增 `web.navigationItems` point。

Web host 在不 activation Extension 时应能够构建：

- application catalog；
- navigation entry；
- display name / icon；
- lazy activation target。

因此 `web.applications` 应优先采用 manifest declaration + runtime binding。

和 CLI 一样，Web declaration parser 由 Control 的 Web point definition 私有持有；`@portable-devshell/extension/web` 不导出 host-side parser。这样 author-facing contract 与宿主 validation implementation 不会被同一个 leaf entrypoint 混在一起。

### 9.5 不应导出的内容

Web Extension API 不应导出：

```text
React components
WebStore
ControlWebSessionService
HttpHost
raw IncomingMessage / ServerResponse
proxy implementation
WebSocket implementation
```

Extension application 不得要求访问 portable-devshell 主 Web DOM。

### 9.6 Navigation 是否单独成为 point

第一版不建议创建 `web.navigationItems`。

如果一个 application 天然需要导航入口，可以把必要 presentation metadata 作为 `web.applications` declaration 的一部分，由 Web domain 自动投影到 navigation。

只有未来出现“没有 application、只贡献导航动作”这类真实需求时，再定义独立 point。

### 9.7 `web.pages`

> 实现状态：4.2.0 首次落地；当前 API 5.0.0 沿用这一 point contract。

`web.pages` 用于向 portable-devshell 主 Web shell 注入由 Host 渲染的管理页面。它与 `web.applications` 分离：前者返回 Web-domain 的 table / row / cell / action snapshot，后者仍拥有完整 browser application content source。

这一版刻意不导出 React component、DOM、router、WebStore 或 iframe contract。曾验证过把 Extension application 嵌入 iframe 的方案，但现有 application CSP 与 same-origin session/DOM 隔离都使其不适合作为 public management ABI，因此没有保留。

第一版 contract 由 Access endpoint 与 Agent provider 两种真实资源管理场景共同验证。Agent 不需要新增 Web primitive，但它的 provider mutation 仍遵守 local-owner 约束，因此 Agent 的 `web.pages` 只投影 provider 状态；这说明 page 是否可执行 mutation 属于 Extension 自己的 authority policy，不由 Web presentation contract 强行统一。

## 10. Agent Domain

Agent 当前本身就是 builtin Extension，因此必须避免把 Agent-specific 业务重新塞回 core Extension ABI。

### 10.1 Agent operations 不是 generic point

当前 Agent 的：

```text
list
get
start
prompt
steer
followUp
abort
reload
stop
```

属于 Agent domain operations。

它们不能被抽象成：

```text
rpc
api
service
operation
```

然后冻结为所有 Extension 都有的 public ABI。

历史 generic `extension.call` 已从当前 public ABI 移除，不是 Agent operations 的入口。

### 10.2 `agent.providers` 是合理的未来 Extension Point 候选

Agent 已经存在 Pi provider，并且 provider 是清晰的 Agent-domain implementation category。

因此未来可能定义：

```text
agent.providers
```

这里 `providers` 的 owner 是 Agent domain，而不是 Extension core。

Provider runtime 现在由 Agent Extension 自己管理，第三方依赖在客户端安装，不再存在独立 Provider artifact。未来若引入 `agent.providers` Extension Point，仍然会引入额外问题：

```text
Extension dependency
point owner availability
owner version compatibility
activation order
uninstall ordering
```

这些语义没有设计完成前，先保持 Agent provider 作为 Agent domain 内部边界。

### 10.3 Renderer 不应提前公开

Pi tool renderer 目前属于 Pi provider adapter，不足以证明存在：

```text
agent.renderers
```

这样的通用 Agent Extension Point。

只有多个独立 Agent provider 对同一种 presentation contract 有真实需求后，才应该定义。

## 11. Tool Domain（通用 point 提案）

> 本节保留通用 Tool-domain point 的设计理由，不能理解为当前没有工具 contribution。当前 `mcp.tools` 已提供 MCP-facing tool declaration/binding，`toolcall.review/rewrite` 也已落地；它们各有 domain contract，不能混作未来通用 Tool point。

Tool contribution 是未来非常有价值、但安全边界较重的候选 Extension Point。

该通用提案若开放，应由 Tool Catalog / execution domain 拥有；这是提案的 ownership 原则，不否定当前 MCP-owned `mcp.tools`。

原因：

```text
Tool
    -> approval
    -> scheduler
    -> audit
    -> execution
```

MCP 只是 Tool catalog 的一个投影和调用入口。

当前 root ABI 中 `worker.execute` / `worker.delegate` capability 的 `listTools()` 只返回 `ExtensionWorkerToolDefinition`，用于描述一个已打开 Worker session 暴露的远端工具。这里刻意使用 `Worker` 前缀，避免把 Worker-access DTO 误解成 Extension core 已经定义了 Tool-domain contribution contract。

因此未来应该考虑一个 Tool-domain contribution point，而不是把它设计成 MCP-owned Extension Point。

它必须确保 Extension-contributed tool 仍经过正常：

```text
approval
scheduler
audit
cancellation
provenance
```

历史第一阶段没有开放此处设想的通用 Tool-domain point；该提案仍不等同于当前已实现的 `mcp.tools`。

## 12. MCP Domain

> 当前实现：`@portable-devshell/extension/mcp` 已 export `tools`（point `mcp.tools`）。静态 declaration 提供输入/输出 schema、metadata，runtime binding 执行工具，Comment 的 `progress_report` 为实际用例；catalog 随 Extension declaration 更新。它与 `cli.model-commands` 的 shell shim 和 instance model allowlist 独立。以下“不进入第一版”的论述只记录原始范围和尚未实现的 resources/prompts 提案，不描述当前 tools 支持范围。

MCP 是协议/Host domain，不应该成为“所有可调用功能”的垃圾桶。

以下能力不应因为最终会被 MCP 看见，就归到 MCP Extension Points：

```text
Tool contribution
Agent operations
Worker execution
Artifact operations
```

原始设计建议仅为 MCP-specific 语义建立 MCP-owned point；当前已扩展为包含 `mcp.tools`。仍可考虑、但尚未实现的其他候选是：

```text
MCP resources
MCP prompts
protocol-specific metadata
```

上述 resources/prompts/metadata 扩展仍是候选；历史第一版未纳入它们。

## 13. TUI Domain

> 实现状态：4.2.0 首次落地 `tui.pages`；当前 API 5.0.0 沿用这一 point contract。

TUI 不复用 `web.pages`，也不调用 CLI argv contract。`tui.pages` 返回 terminal-specific item / line / action snapshot，由 Host 接入已有 route stack、Box、focus、scroll 与 confirmation 交互；Extension 不依赖 Ink component tree 或 portable-devshell 内部 React state。

当前第一版只覆盖 list/detail/action。Access endpoint 与 Agent provider 已经分别验证了不同状态模型和 action 集合，其中 Agent 还使用 `localOwner` 保留 provider mutation 的本地权限边界。form、wizard、streaming 等能力必须从新的真实 TUI 用例继续归纳，不能为了和 Web surface 对齐而加入 generic UI DSL。

## 14. Instance / Provider Domain

local / ssh / docker / podman / reverse provider 直接关系到 Worker bootstrap、连接、安全和配置兼容。

虽然未来理论上可以形成 provider Extension Point，但这属于高风险 core infrastructure。

在没有完整设计以下内容前，不作为 public Extension Point：

```text
provider configuration schema
credential handling
connection ownership
worker bootstrap
reconnect semantics
security policy
cross-platform support
```

不要为了“Extension Points 表现力强”而把所有 internal interface 都开放成 point。

## 15. Extension 定义自己的 Extension Point

长期模型应该允许 Extension domain 自己拥有 point，这也是 Extension Points 最大的表现力来源之一。

例如：

```text
Agent Extension
    defines agent.providers

Third-party Agent Provider Extension
    registers implementation
```

但这不是第一阶段功能。

在开放之前必须补全：

```text
owner Extension dependency declaration
point contract versioning
load/activation ordering
owner disable/uninstall behavior
dependent generation retirement
conflicting owner identities
```

第一阶段只允许 portable-devshell builtin host domains 定义 public Extension Points。

这不会限制元模型，后续无需推翻 ABI 即可扩展到 Extension-owned points。

## 16. Extension Module 生命周期

Public module contract 应保持最小。

目标语义：

```text
activate
    establish generation-owned state and bindings

deactivate
    release Extension-owned state on graceful retirement
```

Host 自己的 generation state machine 可以包含：

```text
activating
active
draining
faulted
closed
```

但这些 host state 不应该全部成为 Extension callback。

Control-owned registrations、Worker sessions、managed processes 等不能依赖 Extension 的 `deactivate()` 才能回收。

### 16.1 历史 `onInstanceRetire` 的迁移

历史 Agent 的 `onInstanceRetire` 是 Worker session ownership 不完整的补丁；当前 public module 不提供该 callback。

目标关系应为：

```text
instance retires
    -> Control closes Worker session
    -> session.closed settles
    -> Agent observes owned session loss
    -> Agent stops corresponding runtime
```

因此不保留 generic `lifecycle` contribution。

## 17. Worker Session 生命周期补充

为了删除 `instance-lifecycle` hook，Worker session contract 应有可观察终止语义。

概念上至少需要：

```text
open
closed
close
```

其中 `closed` 能区分：

```text
caller close
instance disabled
instance deleted
connection loss
generation fault
```

具体 reason taxonomy 应由 Worker/session domain 单独设计，不塞进 Extension Point core。

## 18. Activation 与 Lazy Loading

Static Extension Point declaration 允许 Control 建立 catalog，而不立即执行 Extension code。

> 实现状态：已落地。Manifest schema 1.1.0 使用必填的 `activation: "lazy" | "eager"` 描述 steady-state policy。Control startup 先完成所有 enabled Extension 的 manifest-backed static catalog，再激活 `eager` Extension；`lazy` Extension 仍在首次 binding acquisition 时按需 activation。

`lazy` steady-state 模型：

```text
Control starts
    -> read manifests
    -> validate capabilities
    -> validate Extension Point declarations
    -> publish static catalogs

first bound invocation
    -> activate generation if needed
    -> bind implementations
    -> invoke
```

`eager` steady-state 模型：

```text
Control starts
    -> read and validate all enabled manifests
    -> publish all static catalogs
    -> activate enabled eager generations
```

安装事务采用更强的验证路径，并保持 validation runtime 与 steady-state runtime 分离：

```text
install new immutable generation
    -> static declaration preflight
    -> activate candidate for binding/resource validation
    -> retire validation runtime
    -> lazy:
         commit selected + last-known-good generation
         publish static catalog
         state = installed
    -> enabled eager:
         create a fresh activation incarnation
         atomically commit registry + catalog + active generation
         state = active
```

这样可以同时保证：

- 一个静态 point conflict 在 Extension code 执行前就被拒绝；
- 一个缺失 binding / 非法 binding resource 在 install 时就被拒绝；
- `lazy` 安装成功不会强迫 Extension 常驻；
- `eager` 不复用 validation runtime，而是创建独立的 steady-state activation；
- hot replacement 后旧 generation 仍可按已有 lease drain；
- last-known-good 只指向通过完整 candidate validation 的 generation。

需要后台常驻的 Extension 使用显式 `activation: "eager"`；普通按需 Extension 使用 `activation: "lazy"`。Activation policy 不引入万能 `onStart` lifecycle hook，Extension 公共生命周期为 `activate()`、可选 `deactivate()`，以及用于 Extension-owned state 的两个精确 terminal notification；它们不负责 Host resource reclamation。

## 19. Error 与 Fault Boundary

Point owner 定义 domain error contract，Extension core 只负责 generation fault isolation。

例如：

```text
CLI command failure
    != Web application unavailable
    != Tool invocation failure
```

不要建立一个巨大 `ExtensionOperationError` 覆盖所有 domain semantics。

当前 Web owner 已落实该边界：static catalog 中不存在的 application 是 404；已发布但 binding activation/source 不可用是 503；endpoint upstream failure 是 502。ExtensionHost/generation failure 与 Node upstream exception 只作为宿主内部诊断信息，不能把原始 message/path/socket error 反射进 HTTP/WebSocket 响应。

CLI owner 采用不同但同样明确的边界：command binding 已经开始执行后，它主动产生的 usage/business error 属于 CLI command contract；但在 binding 之前发生的 registration/generation acquisition failure 必须归一成固定 `control.cliCommandFailed`，不得把 `control.extension*` 或 Host cause 穿过 CLI route。这样不会为了 fault isolation 吞掉命令本身有意义的反馈，也不会让 ExtensionHost 变成 CLI error taxonomy 的隐式 owner。

以下错误可由 Extension runtime 统一处理：

```text
unknown point id
undeclared registration
invalid declaration
invalid binding
sandbox unavailable
generation faulted
message budget exceeded
```

## 20. Versioning

第一版正式 release 前只维护一套 ABI，不保留未发布 compatibility。

初期建议：

- Extension manifest schema version：负责 manifest syntax；
- Extension API version：负责 core runtime ABI；
- Domain Extension Point contract 随 Extension API 一起演进。

不要一开始就为每个 point 引入独立 semver。

只有未来允许第三方 Extension 定义自己的 Extension Points 时，才需要独立研究 point-owner contract versioning。

## 21. 历史第一阶段范围与当前落地

最初阶段只规划 assets/artifacts、粗粒度 instances/workers、processes 与 CLI/Web/TUI points。`instances/workers` 是历史设计用语，不是现行 grant，不能写进当前 manifest。当前已拆为十二项 capabilities，且增加 Control、Execution、MCP、ToolCall points，见顶部清单。

历史迁移目标中的 generic command/rpc/web/lifecycle contribution object、`extension.call` 与 `onInstanceRetire` 不属于当前 API。Generation-owned registrations、Control-owned resources 与两个窄化 terminal notifications 已落实。

当前 Agent、Comment、Access、Direnv、Artifact、Instance、MCP、Recall、Secret、Skill、Storage 的 manifest 映射见[现行 builtin 表](../concepts/extensions.md#builtin-extension-映射)。其中 Agent 使用 `database`；Access 同时使用 owned config 和 `config.core`；Skill/Secret 通过 `worker.execute` 提供 model workspace 命令；Comment 注册 control、MCP 和 ToolCall points 并协调 Worker Memory/Mailing。不要把最初五个 builtin 的缩减映射当作当前 manifest。

## 22. 仍未实现的提案与明确边界

Extension-defined points、`agent.providers` public point、Instance provider plugin、MCP resources/prompts、通用 Tool-domain contribution point 与 runtime optional capability prompt 均不在当前 ABI 中。独立 `/agent`、`/tools` SDK subpath 也没有发布。

TUI 当前已有结构化 `tui.pages`，但没有任意 TUI component/plugin UI；MCP 当前已有 `mcp.tools`，不能继续一概列为“没有 MCP contribution”。完整 OS malicious-code sandbox 不是当前 worker-thread isolation 的保证。

## 23. API 形状示意

以下使用当前公开的 CLI/Web descriptor 名字表达 registration 结构；`context` 与 `implementation` 是示意变量，运行时 binding 必须与完整 manifest declaration 一一对应。

### Core

```ts
import type { ExtensionContext } from "@portable-devshell/extension";

export async function activate(context: ExtensionContext): Promise<void> {
    // acquire declared capabilities
    // bind declared Extension Point implementations
}

export async function deactivate(): Promise<void> {
    // Extension-owned graceful cleanup only
}
```

### CLI domain

```ts
import { nativeCommands } from "@portable-devshell/extension/cli";

// bind implementation for a command declared in the manifest
context.register(nativeCommands, "agent", implementation);
```

### Web domain

```ts
import { applications } from "@portable-devshell/extension/web";

// bind implementation for an application declared in the manifest
context.register(applications, "agent", implementation);
```

这里 `nativeCommands` 与 `applications` 不需要彼此处于同一 taxonomy；它们分别属于 CLI 与 Web domain。

真正必须保持同类的是：

```text
CLI domain 内自己的并列概念
Web domain 内自己的并列概念
Capability 集合内部的资源类别
Generation lifecycle 内部的状态/动作
```

## 24. Public ABI 审查门禁

任何新增 public Extension API 必须回答：

1. **Owner 是哪个 domain？**
2. **它是 capability、Extension Point、lifecycle，还是普通 domain DTO？**
3. **与同级名称是否属于同一 domain / level / direction？**
4. **是否只是当前 transport / framework implementation 泄漏？**
5. **是否有至少一个真实 Extension 用例？**
6. **为什么不能由现有 Extension Point 表达？**
7. **谁拥有它的 lifecycle？**
8. **generation fault 后谁负责强制 cleanup？**
9. **是否把 Control/Core internal class 暴露给了 Extension？**
10. **是否要求为了一个 builtin Extension 修改 Extension core taxonomy？**

第 10 项如果答案为“是”，默认应拒绝，并优先考虑由对应 domain 定义新的 Extension Point。

## 25. 参考设计

本设计借鉴但不复制以下成熟插件系统的边界：

- Visual Studio Code Extension API：区分 manifest Contribution Points 与 Extension runtime API；Contribution Points 可以在 Extension activation 前被发现。
    - https://code.visualstudio.com/api/get-started/extension-anatomy
    - https://code.visualstudio.com/api/references/contribution-points
- IntelliJ Platform：由 platform/plugin domain 定义 Extension Point，插件向具体 Extension Point 注册实现；Extension Point 不被压缩成一个中央功能 enum。
    - https://plugins.jetbrains.com/docs/intellij/plugin-extensions.html
    - https://plugins.jetbrains.com/docs/intellij/plugin-configuration-file.html
- Chrome Extensions：manifest capability/permission 与功能声明分离，说明“获得什么 authority”和“提供什么功能”应当是不同维度。
    - https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions

portable-devshell 与这些系统不同之处在于：

- Extension 默认运行在 Control sandbox generation；
- capabilities 主要描述 Control-managed runtime resources，而不是完整 OS permission model；
- Worker execution、managed process、asset projection 都需要与 generation ownership 集成；
- public Extension Point callback 必须可以跨 worker-thread sandbox transport，但 transport 不进入 domain ABI。

## 26. 最终不变量

实现完成后必须保持：

```text
1. manifest 只有一个 capabilities grant 字段。
2. capability 只包含同级 host-managed resource categories。
3. Extension core 不维护 command/web/tool/provider 等功能 enum。
4. 每个 Extension Point 由自己的 domain owner 定义。
5. Extension Point 的 public identity 不依赖 JS object identity。
6. Domain public API 不暴露 runtime implementation package。
7. registration 默认属于 generation，并由 Control 自动回收。
8. managed resource 默认属于 generation，并由 Control 自动回收。
9. RPC/HTTP/MessagePort 等 transport 不成为 public Extension domain。
10. lifecycle 不允许退化成 generic callback bucket。
11. 未发布错误 ABI 不保留兼容层。
12. 没有真实用例的 Extension Point 不提前公开。
13. Invocation-scoped Host interface 只能由 point owner 注入当前调用的收窄 authority，不能退化成通用 service locator 或 generation capability。
```

这十三条是后续实现与 code review 的停止条件。
