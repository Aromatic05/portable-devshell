# Extension 架构与 ABI 设计

> 状态：核心元模型、static catalog、lazy activation 与第一批 CLI/Web domain discovery 已实现；后续章节继续约束未来 Extension Point 演进。
>
> API v3 已落地 `assets / workers / processes` capabilities、`cli.commands / web.applications` Extension Points、generation-owned registrations，以及最小 `activate / deactivate` module 生命周期。`docs/concepts/extensions.md` 描述当前运行时契约；本文保留设计推导、后续候选项和 public ABI 审查门禁。

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

### 2.6 不为未发布 ABI 保留兼容层

当前 Extension ABI 尚未正式 release，因此迁移到本文模型时应直接删除错误设计，不保留 v2/v3 双轨、旧 capability alias 或旧 activation contribution 兼容逻辑。

## 3. 总体模型

```text
┌────────────────────────────────────────────┐
│ Extension Package                          │
│                                            │
│ identity                                   │
│ entry                                      │
│ dependencies                               │
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
│ assets               │   │ CLI-owned points       │
│ workers              │   │ Web-owned points       │
│ processes            │   │ future domain points   │
└──────────────────────┘   └────────────────────────┘
```

Generation 是 ownership root。

正常关闭时：

```text
generation close
    -> stop accepting new invocations
    -> drain active invocations
    -> revoke registrations
    -> close Worker sessions
    -> close managed processes
    -> release other generation resources
    -> run Extension-owned deactivation cleanup
    -> terminate sandbox
    -> remove runtime directory
```

异常 fault 时允许跳过 Extension 自己的 cleanup，但 Control-owned resource 必须仍可强制回收。

## 4. Manifest

Manifest 只描述安装前和 activation 前可知的静态事实。

概念结构：

```text
Extension Manifest
├── identity
├── entry
├── dependencies
├── capabilities
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
    "capabilities": ["assets", "workers", "processes"],
    "extensions": {
        "cli.commands": [
            { "id": "agent", "title": "Agent" }
        ],
        "web.applications": [
            { "id": "agent", "title": "Agent" }
        ]
    }
}
```

这里的 point id 由 domain 定义，而不是由 Extension core 维护 enum。

`extensions` 这个字段名在实现前仍可做最后一次命名审查，但其**语义位置已经确定**：它描述 Extension Point declarations，不描述 capability。

### 4.3 为什么需要静态 declaration

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

### 4.4 declaration 不是 implementation

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

第一版候选集合：

```text
assets
workers
processes
```

三者都是：

> 由宿主管理、由 Extension 获得操作权的一类 runtime resource。

### 5.2 `assets`

`assets` 允许 Extension 管理自己拥有的不可变 asset generations，并通过受控路径投影到 Worker。

它不意味着任意 Control filesystem access，也不把 Asset 内部 storage layout 暴露给 Extension。

### 5.3 `workers`

`workers` 允许 Extension 打开受 Control 管理的 Worker sessions，并调用正常 Tool pipeline。

它不暴露：

```text
WorkerInstance
provider transport
Worker protocol client
SSH / Docker / Reverse connection
raw worker RPC
```

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

### 5.5 Runtime context

目标概念结构：

```text
ExtensionContext
├── identity
├── paths
├── logger
├── capabilities
└── registration API
```

其中：

```text
context.capabilities.assets
context.capabilities.workers
context.capabilities.processes
```

必须和 manifest grant 一一对应。

没有声明的 capability 不应以“看起来可用、调用时才失败”的 manager 形式伪装存在。

### 5.6 Capability 不是 OS security permission

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

Point identity 使用稳定 namespaced id：

```text
cli.commands
web.applications
agent.providers
tools.tools    // 仅示意；具体命名必须由 Tool domain 再审
```

Point id 是协议 identity，不依赖 JavaScript object identity。

这一点非常重要，因为 Extension SDK 可能被 bundle 进 `.dsext`；Host 和 Extension 不能要求共享同一个 JS object instance 才能识别 point。

### 6.3 Registration identity

每个 registration 使用 Extension-local id。

Global identity 由 Host 组合：

```text
<point-id> + <extension-id> + <local-registration-id>
```

Extension 不允许注册到别人的 namespace。

`extension-id` 与各 Extension Point 的 local id 是不同 namespace。CLI 内置 command name 的冲突检查属于 `cli.commands` owner，不能用一组 CLI 名称去全局禁止同名 Extension id。例如 Extension `status` 可以合法提供 `cli.commands/custom-command`；反过来任意 Extension 都不能声明实际被内置 CLI tree 截获的 `cli.commands/status`。

### 6.4 Registration ownership

Runtime registration 默认属于当前 generation：

```text
generation
    owns registration
```

Generation retirement 自动撤销 registration。

Runtime Host 只拥有 registration identity、lazy activation、generation lease 和 acquisition，不解释某个 point 的 binding 业务语义。具体 point owner 在取得 registration lease 后负责校验并调用 binding。例如 `cli.commands` 的 binding invocation 属于 CLI domain，而不是 `ExtensionHost` 的 `dispatchCommand` 一类特殊方法。

同样，manifest declaration 与 activation binding 的校验规则也属于 point owner。Generic runtime 可以要求“声明与 binding 一一对应”和“未知 point 被拒绝”，但不能自己实现 `cli.commands` 必须是 function、`web.applications` files source 必须位于 code generation 内这类 domain-specific 规则。

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

建议 Extension SDK 使用显式 domain subpath：

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
import { commands } from "@portable-devshell/extension/cli";
```

得到的 runtime descriptor 最终依靠稳定 point id 识别，而不是：

```ts
hostPoint === extensionBundledPoint
```

这样的 object identity。

这允许 `.dsext` 自包含 SDK helper，而不需要通过 `hostDependencies` 暴露 `@portable-devshell/*` internal packages。

## 8. CLI Domain

### 8.1 第一批 Extension Point：`cli.commands`

当前 Skill、Secret、MCP Client、Agent 都需要 CLI 接入，因此 CLI 是第一批必须落地的 point owner。

`cli.commands` 表示：

> Extension 向 portable-devshell CLI command tree 提供一个或多个 command entries。

它不是 capability。

### 8.2 静态 declaration 应承担的内容

> 实现状态：已落地。Control 通过 CLI domain-owned `commands` discovery 只投影 `cli.commands` declaration metadata；`devshell <extension-command> --help` 在不 activation Extension 的情况下生成 help。全局 `devshell --help` 仍保持离线、本地解析。

CLI 在 Extension 未 activation 时就应该能够：

- 构建 command tree；
- 生成 help；
- 检测 command id 冲突；
- 知道哪个 Extension 需要按需 activation。

CLI domain 还必须在 declaration validation 阶段拒绝与内置顶层 command 冲突的 local id。这个规则只约束 `cli.commands` registration id，不约束 Extension 自身 id；builtin Extension identity（当前 `skill / secret / mcp`）是 install domain 的另一条独立保护规则。

因此 metadata 应尽可能 declarative。

候选内容：

```text
local id
title / summary
usage shape
possibly subcommand metadata
```

具体字段由 CLI parser 的最终模型决定，不在 Extension core 中定义。

当前 discovery transport 也不是 generic Extension catalog：CLI domain 只返回 `extensionId / id / title / summary / usage`，不暴露 generation、runtime binding、sandbox callback token 或 Control transport details。

### 8.3 Runtime binding

> 实现状态：已落地。CLI discovery 和 invocation 现在由同一个 CLI domain owner 承担；Control 的 Extension management route 不再包含 command dispatch。CLI route 自己负责 caller authority、payload/result validation，并通过 generation-owned binding 执行 command。

Runtime binding 只负责执行：

```text
parsed invocation
    -> Extension command implementation
    -> domain-defined result
```

不要重新暴露一个 generic `argv -> JSON` RPC 作为所有 Extension 的共同模型。

如果 CLI domain 决定保留 raw argv，它也是 `cli.commands` 自己的 contract，不是 Extension core primitive。

### 8.4 Working directory

local-owner CLI 的 working directory 是 CLI invocation domain 的语义，应继续由 CLI point invocation context 明确传递。

Extension 不得读取 Control daemon 自己的 `process.cwd()` 来猜用户工作目录。

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

当前 generic `extension.call` 没有证明自己具有跨 domain 的必要性，应在迁移时删除。

### 10.2 `agent.providers` 是合理的未来 Extension Point 候选

Agent 已经存在 Pi provider，并且 provider 是清晰的 Agent-domain implementation category。

因此未来可能定义：

```text
agent.providers
```

这里 `providers` 的 owner 是 Agent domain，而不是 Extension core。

它可以最终替代或统一当前独立 `.dsprovider` 的部分机制，但**第一批 Extension Point 迁移不应顺手做这个重构**。

原因是允许 Extension 自己定义 / 拥有 Extension Points 会引入额外问题：

```text
Extension dependency
point owner availability
owner version compatibility
activation order
uninstall ordering
```

这些语义没有设计完成前，先保持 Agent provider 的现有独立边界。

### 10.3 Renderer 不应提前公开

Pi tool renderer 目前属于 Pi provider adapter，不足以证明存在：

```text
agent.renderers
```

这样的通用 Agent Extension Point。

只有多个独立 Agent provider 对同一种 presentation contract 有真实需求后，才应该定义。

## 11. Tool Domain

Tool contribution 是未来非常有价值、但安全边界较重的候选 Extension Point。

如果开放，应由 Tool Catalog / execution domain 拥有，而不是 MCP domain。

原因：

```text
Tool
    -> approval
    -> scheduler
    -> audit
    -> execution
```

MCP 只是 Tool catalog 的一个投影和调用入口。

因此未来应该考虑一个 Tool-domain point，而不是：

```text
mcp.tools
```

它必须确保 Extension-contributed tool 仍经过正常：

```text
approval
scheduler
audit
cancellation
provenance
```

第一版 Extension Point 迁移不开放该 point，直到 Tool contract 和 security policy 单独审查完成。

## 12. MCP Domain

MCP 是协议/Host domain，不应该成为“所有可调用功能”的垃圾桶。

以下能力不应因为最终会被 MCP 看见，就归到 MCP Extension Points：

```text
Tool contribution
Agent operations
Worker execution
Artifact operations
```

只有某个能力的语义本身就是 MCP-specific 时，才考虑 MCP-owned point，例如未来真正需要第三方扩展：

```text
MCP resources
MCP prompts
protocol-specific metadata
```

目前没有足够用例，不进入第一版 ABI。

## 13. TUI Domain

当前没有真实需求证明第三方 Extension 需要直接挂载 portable-devshell TUI view。

因此第一版不定义：

```text
tui.views
tui.panels
tui.renderers
```

如果未来开放，必须保证 Extension 只获得稳定 presentation contract，不能直接依赖 Ink component tree 或 portable-devshell 内部 React state。

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

### 16.1 `onInstanceRetire` 应删除

当前 Agent 的 `onInstanceRetire` 是 Worker session ownership 不完整的补丁。

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

> 实现状态：已落地。Control startup / enable 使用 manifest-backed static catalog；CLI/Web 首次 binding acquisition 按需 activation。Install 会执行一次完整 candidate validation 后立即 retire validation runtime，再提交 selected catalog，因此不会为了安装而长期保持 active generation。

推荐 activation 模型：

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

安装事务采用更强的验证路径，但不改变 steady-state lazy 语义：

```text
install new immutable generation
    -> static declaration preflight
    -> activate candidate for binding/resource validation
    -> retire validation runtime
    -> commit selected + last-known-good generation
    -> publish static catalog
    -> state = installed

first real invocation
    -> create a new activation incarnation
    -> invoke through a generation lease
```

这样可以同时保证：

- 一个静态 point conflict 在 Extension code 执行前就被拒绝；
- 一个缺失 binding / 非法 binding resource 在 install 时就被拒绝；
- 安装成功不会强迫所有 Extension 常驻；
- hot replacement 后旧 generation 仍可按已有 lease drain；
- last-known-good 只指向通过完整 candidate validation 的 generation。

并非所有 builtin Extension 都必须 eager activate。

如果某个 Extension 需要后台常驻，则应有明确的 activation policy；不能用一个万能 `onStart` lifecycle hook 暗中实现。

Activation policy 的 manifest 表达方式属于后续设计，不在第一版 point contract 中提前冻结。

## 19. Error 与 Fault Boundary

Point owner 定义 domain error contract，Extension core 只负责 generation fault isolation。

例如：

```text
CLI command failure
    != Web application unavailable
    != Tool invocation failure
```

不要建立一个巨大 `ExtensionOperationError` 覆盖所有 domain semantics。

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

## 21. 第一阶段实施范围

第一阶段只迁移当前已经存在且必要的功能：

### Capabilities

```text
assets
workers
processes
```

### Extension Points

```text
cli.commands
web.applications
```

### Lifecycle

```text
remove command/rpc/web/lifecycle/dispose contribution object
remove generic extension.call public abstraction
replace onInstanceRetire with Worker session closure ownership
make registrations generation-owned
make processes Control-owned
```

### Builtin Extension 映射

```text
Agent
    capabilities: assets, workers, processes
    extensions: cli.commands, web.applications

Skill
    capabilities: assets
    extensions: cli.commands

Secret
    capabilities: none
    extensions: cli.commands

MCP Client
    capabilities: none
    extensions: cli.commands
```

## 22. 明确不做的事情

第一阶段不做：

```text
Extension-defined Extension Points
Agent provider migration
generic service/RPC API
TUI plugin UI
Tool contribution
MCP-specific contribution
Instance provider plugin
runtime optional capability prompt
OS-level malicious-code sandbox
```

这些能力都可以在当前元模型上继续增加，不需要提前塞进 ABI。

## 23. API 形状示意

以下只表达结构，不冻结具体 TypeScript 名字。

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
import { commands } from "@portable-devshell/extension/cli";

// bind implementation for a command declared in the manifest
context.register(commands, "agent", implementation);
```

### Web domain

```ts
import { applications } from "@portable-devshell/extension/web";

// bind implementation for an application declared in the manifest
context.register(applications, "agent", implementation);
```

这里 `commands` 与 `applications` 不需要彼此处于同一 taxonomy；它们分别属于 CLI 与 Web domain。

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
```

这十二条是后续实现与 code review 的停止条件。
