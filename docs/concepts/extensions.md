# Extension ABI

portable-devshell 的 Extension 运行在 **Control**。Worker 不加载 Extension，也不存在 native Worker plugin ABI。

当前 public Extension API version 为 `4`。Builtin Extension 与独立安装的 Extension 使用同一套 ABI；builtin 身份不绕过 capability、registration、sandbox 或 generation ownership。

## 核心模型

Extension ABI 由三个正交概念组成：

```text
Capabilities
    Control -> Extension
    Extension 获得宿主管理资源的 authority

Extension Points
    Extension -> host domain
    Extension 为某个 domain 提供实现

Generation Ownership
    决定 capability resource、registration 和 sandbox 的生命周期
```

Capability 不是 contribution，Extension Point 也不是 permission。Transport（RPC、MessagePort、HTTP proxy、child-process IPC 等）属于 runtime implementation，不进入 public ABI taxonomy。

## Manifest

Manifest 在 activation 前描述静态事实：

```json
{
    "schemaVersion": 1,
    "apiVersion": 4,
    "id": "example",
    "name": "Example",
    "version": "1.0.0",
    "entry": "index.js",
    "hostDependencies": [],
    "capabilities": ["assets", "workers"],
    "extensions": {
        "cli.native-commands": [
            { "id": "example", "title": "Example" }
        ]
    }
}
```

`capabilities` 只包含宿主管理资源类别。当前集合是：

```text
artifacts
assets
instances
processes
workers
```

`artifacts` 与 `instances` 是 Control-owned management resources：前者提供受控的 share/transfer 管理，后者提供 instance 配置、状态、日志、事件与生命周期操作。它们不暴露 Control 内部 service/registry，也不是 generic RPC capability。

`extensions` 按稳定的 domain-owned Extension Point id 保存静态 declaration。它不授予任何资源权限。

Runtime binding 必须与 manifest declaration 严格对应：未声明 registration、重复 registration、声明后没有 binding、未知 point 或不合法的 domain declaration 都会使 candidate activation 失败。

### Static catalog 与 lazy activation

Control 启动时不会为了发现 Extension Point 而执行所有 Extension code。对每个 enabled Extension，Host 先读取 selected generation 的 manifest，并完成 domain declaration 校验与跨 Extension registration conflict 检查，然后发布静态 catalog。

此时 Extension 的 runtime record 可以处于：

```text
state = installed
selectedGeneration = <generation>
activeGeneration = absent
```

`installed` 在这里表示“generation 已选择且静态入口可路由，但当前没有 live activation”，不是安装不完整。

第一次需要 bound implementation 时：

```text
CLI/Web request
    -> resolve static catalog owner
    -> activate selected generation
    -> validate declaration/binding 1:1
    -> acquire generation lease
    -> invoke binding
```

如果 selected generation 在首次 activation 时失败，Host 可以按 registry 中已经验证过的 last-known-good generation 回退。Host 自身的 registry persistence failure 不会被误判成 candidate failure，也不会因此盲目切换 generation。

Install 仍然保留强验证：新的 immutable generation 会实际执行一次 activation、binding/resource validation，然后立即 retire 这次验证 runtime；只有验证和 cleanup 都成功后，才提交 selected / last-known-good generation 和静态 catalog。因此安装成功不会留下常驻 sandbox，第一次真实调用仍然是独立的 runtime activation。重复安装当前已经选择且健康的同一 content generation 是幂等操作。

显式 `reload` 与 ordinary first-use 不同：它是管理操作，要求立即重新 activation 当前 selected generation。`enable` 只恢复并校验静态 catalog；`disable` 立即撤销静态路由，并让已经存在的 generation leases 按正常 retirement 语义 drain。

## ExtensionContext

Extension module 的公共生命周期保持最小：

```ts
export interface ExtensionModule {
    activate(context: ExtensionContext): Promise<void> | void;
    deactivate?(): Promise<void> | void;
}
```

`ExtensionContext` 的结构是：

```text
identity
paths
logger
capabilities
register(...)
```

典型使用：

```ts
import type { ExtensionContext } from "@portable-devshell/extension";
import { nativeCommands } from "@portable-devshell/extension/cli";

export function activate(context: ExtensionContext): void {
    context.register(nativeCommands, "example", async (argv, invocation) => {
        return { kind: "text", text: argv.join(" ") };
    });
}
```

`deactivate()` 只负责 Extension 自己拥有的 graceful cleanup。Control-owned Worker sessions、managed processes、registrations 等不能依赖 `deactivate()` 才能回收；sandbox fault 时 Host 仍必须能够强制清理它们。

### Paths

```text
codeDirectory
    immutable code generation

dataDirectory
    Extension-owned persistent data

stateDirectory
    mutable state shared across generations

runtimeDirectory
    one activation incarnation only
```

同一个 code generation reload 时，新旧 activation incarnation 可以短暂并存，因此 `runtimeDirectory` 每次 activation 独立，不能被持久化到下一次 reload。

## Capabilities

### assets

`context.capabilities.assets` 管理 Extension 自己拥有的不可变 asset generations：

```text
installBundle
installDirectory
listBundles
projectBundle
resolveBundle
removeBundle
```

asset `generation` 是 opaque identity。Extension 不得解析 generation，也不得依赖 Control 的物理 storage layout。

`projectBundle()` 只接受逻辑 Worker resource target：

```text
instance + collection + key
```

它不接受 raw Worker filesystem path。真实目录由 Worker Resource Host 管理，传输复用 Artifact infrastructure。

`projectBundle()` 会等宿主管理的投影传输完成后再返回 `ExtensionAssetProjectionResult`。Public result 只包含对 Extension 有意义的 projection outcome（当前为 `transferredBytes`）；内部 Artifact `transferId` 只用于 Control 自己的 wait/cancel/diagnostics，不进入 Extension ABI。

### workers

`context.capabilities.workers.openSession()` 是 Extension 的受控 Worker execution 入口：

```ts
openSession({
    instance?,
    workspace
})
```

Session 提供：

```text
closed
environment
instance
workspace
listTools
callTool
close
```

`listTools()` 返回 `ExtensionWorkerToolDefinition`。这个类型只描述当前 Worker session 可调用的远端工具目录，是 `workers` capability 的 DTO；它不代表 Extension core 拥有 Tool contribution taxonomy，也不是未来 Tool-domain Extension Point 的 declaration contract。

`closed` 是 host-owned lifecycle signal。instance disabled/deleted、connection loss、generation cleanup 或 caller close 都会最终使 session 不再可用；依赖 Worker 的 Extension 应观察 session closure，而不是要求 generic lifecycle broadcast。

工具调用仍经过正常 approval、scheduler 和 audit pipeline，并以 Extension 归因。Public ABI 不暴露 `WorkerInstance`、provider transport、Worker protocol client 或 raw Worker RPC。

### processes

`context.capabilities.processes` 创建 **Control-owned managed process**，不是授予 Node `child_process` 权限：

```text
Extension
    -> processes.start(...)
    -> Control Process Manager
    -> Managed Process
```

Managed process 可以暴露受控 structured-message channel、stderr、termination 和 `closed` result。Generation fault / retirement 时 Control 会回收仍存活的 managed processes；IPC channel 意外断开也会触发回收。

Extension sandbox 本身仍拒绝裸 `child_process`，因此 sandbox 被 terminate 后不会留下不受 generation ownership 管理的子进程。

## Extension Points

Extension Point 由具体 host domain 拥有，而不是由 Extension core 维护一个全局 kind enum。

Point identity 使用稳定 namespaced string：

```text
cli.native-commands
cli.model-commands
web.applications
```

Registration 使用 Extension-local id；Host 结合 point id、Extension id 和 local id 建立全局 identity。Runtime registration 默认属于当前 generation，generation retirement 自动撤销。

Extension id 与 point-local registration id 是独立 namespace；不同 Extension Point 之间也是独立 command state。`cli.native-commands/status` 可以与 builtin `status` 同名，也可以同时存在 `cli.model-commands/status`。冲突只在同一个 Extension Point 内判断；builtin command tree 不参与 Extension registration conflict。

Native CLI 的 resolution 明确采用 overlay：先解析 enabled `cli.native-commands`，没有匹配项时才回退 builtin command。Model command state 完全独立，只解析 `cli.model-commands`；它永远不会因为 model command 缺失而回退 builtin 或 native command。这条边界既是交互模型，也是安全不变量。

Control 的 Extension runtime Host 对 point domain 保持中立：它负责 static catalog、lazy activation、registration acquisition 和 generation lease，但不 import CLI/Web point contract，也不提供 `dispatchCommand`、`dispatchWeb` 之类的 domain-specific dispatch API。取得 lease 后，binding 的类型校验、调用和结果语义由对应 domain service 自己负责。

当前 Control 在 composition 层构造内部 `ExtensionPointRegistry`。CLI/Web 各自注册 point definition：declaration schema、binding shape 和 point-specific resource validation 留在 domain owner；`ExtensionRegistration`、`ExtensionCatalog`、`ExtensionLoader` 只通过 registry 委托。这个 registry 不导出给 Extension，也不是一个 central point-kind enum。

Sandbox transport 同样保持 domain ownership。Worker `ready` registration 只携带 point id、local id 和 opaque JSON descriptor；generic sandbox runtime 只提供私有 binding invocation bridge，不知道 `cli.command`、`web.files`、`web.endpoint` 这类 point-specific wire kind。CLI/Web 的内部 sandbox codec 负责 descriptor、Worker-side binding invocation 和 Host-side proxy restoration。该 generic bridge 只存在于 Control 私有实现层，不是 public `extension.call` 或 generic RPC ABI。

Control composition 还会校验 host `ExtensionPointRegistry` 与 sandbox codec registry 的 point-id 集合完全一致。这个 parity gate 只约束两套私有实现投影，避免新增 point 时只注册 declaration/binding owner 或只注册 sandbox codec；它不是第三套 public registry，也不会把 codec/transport identity 暴露给 Extension。

Public SDK 按 domain subpath 发布 leaf contract：

```text
@portable-devshell/extension
@portable-devshell/extension/cli
@portable-devshell/extension/web
```

root 只导出 core ABI；CLI/Web domain contract 不从 root 聚合，也不要求 Extension 依赖完整 CLI/Web runtime package。

CLI/Web leaf 也只导出 Extension author 需要的 point descriptor、declaration/binding/context/result types。Manifest declaration 的 schema parser 属于 Control 中对应 domain owner 的 host validation implementation，不从 public leaf SDK 导出。

### CLI command states

`@portable-devshell/extension/cli` 当前公开：

```text
nativeCommands
modelCommands
CliCommandDeclaration
CliNativeCommandBinding
CliNativeCommandInvocationContext
CliModelCommandBinding
CliModelCommandInvocationContext
CliCommandResult
```

两个 point 共用 declaration shape，可以提供 `title`、`summary` 和 `usage`，但 registration/catalog/dispatch state 完全独立。Binding 都由 CLI domain 定义为 argv + invocation context -> CLI result；这是 CLI 自己的 contract，不是 generic Extension RPC。

`CliNativeCommandInvocationContext` 当前包含 `localOwner`、`requestId`、`signal` 和可选 `workingDirectory`，描述本地/远程 native CLI 的 authority、取消和 Control-host path 语义。`CliModelCommandInvocationContext` 刻意只公开 `requestId` 和 `signal`：它不携带 `localOwner`、Control-host cwd 或 raw `ctxId`，因此 Extension 不能把 model invocation 伪装成 native owner invocation。两种 context 都由 CLI leaf contract 拥有，不从 root 导出 generic `ExtensionInvocationContext`。

Control 内部 static catalog 由 CLI domain 按 state 分别投影。Native discovery 只包含 `cli.native-commands` 的 presentation metadata，不包含 generation 或 runtime binding；本地 CLI 用它在 builtin parser 之前判断 overlay。`devshell <native-extension-command> --help` 因而可以只靠静态 declaration 生成帮助，普通 argv 仍按需取得 generation lease。全局 `devshell --help` 仍不依赖 Control。

Native command invocation 仍由 Control 的 CLI route 负责 CLI-only access、`workingDirectory` authority、payload/result validation 和 binding dispatch；Extension management route 只负责 install/list/get/enable/disable/reload/remove。Model command state不复用这条 native route。

MCP `bash_run` / managed `tmux_run` 当前通过 Worker-owned executable shim 暴露 restricted `devshell`：Worker 只在 `source=mcp` 的 ToolCall 环境前置私有 `devshell` executable 到 `PATH`，由 shell 自己完成 quoting、pipeline、redirection 和 executable resolution；Control 不解析 command string。shim 通过 Worker local broker 取得 model command stdout/stderr/exit status，远端 Worker↔Control 仍复用已有 Worker RPC channel。

Control 根据 authoritative tool audit + MCP Context 校验 shim 上报的 `ctxId / parentCallId / workspace / taskId`。这些值只是 integrity assertion，不是 bearer authority；不匹配会作为 `worker.protocolIntegrityFault` 拒绝并记录。持久 tmux task 在父 `tmux_run` 完成后通过 audit result 中的 `task.id` 证明原始绑定；Context 已失效时不会自动重绑。Model resolver 最终只连接 `cli.model-commands`，从结构上排除 builtin/native fallback。

CLI command implementation 自己抛出的 usage/business error 仍属于 command contract，可以作为命令反馈呈现；但在执行实现之前如果对应 state 的 registration/generation 无法取得，CLI owner 会翻译成固定 `control.cliCommandFailed` / `CLI command <id> is unavailable.`，只带 `commandId`，不把 ExtensionHost error code、generation path 或原始 cause 暴露到 wire error。

Local-owner CLI 可以在 invocation context 中提供 `workingDirectory`。依赖 Control 主机 project 路径的 Extension 必须使用这个字段，而不能读取 daemon 自己的 `process.cwd()` 猜调用者目录。

### web.applications

`@portable-devshell/extension/web` 当前公开：

```text
applications
WebApplicationDeclaration
WebApplicationBinding
WebApplicationSource
```

Web host 拥有最终 mount path、authentication/session、same-origin/security headers、HTTP/WebSocket transport 和 lease lifetime。

Application binding 只描述 application source：

```text
files
    Extension code directory 下的静态 application directory

endpoint
    Extension 解析得到的受控 application endpoint
```

这些 source kind 属于 Web domain contract，不是 Extension core capability。Extension 不获得 raw `IncomingMessage` / `ServerResponse`、WebSocket implementation 或 portable-devshell 主 Web DOM。

Web domain 同样从 static catalog 投影 application discovery DTO，只暴露 `extensionId / id / title`。主 WebUI 的 navigation 直接由这些 declaration 生成，并链接到 Web host 已有的 `./extensions/<application-id>/` mount。读取 application catalog 或渲染导航都不会 activation Extension；只有真正请求 application content 时才需要 runtime binding。

Web application 的 HTTP/WebSocket failure 也由 Web host 翻译，而不是把 ExtensionHost 或 Node upstream exception 直接暴露给浏览器：未发布 application 返回 404；已发布但 activation/source/generation 暂不可用返回 503；endpoint upstream 建连失败返回 502。响应正文使用固定 Web-domain 文案，不包含 generation path、provider socket、`ECONNREFUSED` 等内部细节。

CLI/Web discovery 都是各自 domain 的 read surface，不存在 public `extension.catalog`、generic contribution listing 或 runtime binding introspection API。

## Generation ownership

Generation 是 runtime ownership root。正常 retirement 的顺序概念上是：

```text
stop accepting new invocations
-> drain active invocation leases
-> revoke registrations
-> close Worker sessions
-> terminate managed processes
-> release other host-managed resources
-> run Extension deactivate() when possible
-> terminate sandbox
-> remove runtime directory
```

Fault path 可以跳过 Extension-owned cleanup，但不能跳过 Host 对 registrations、sessions、processes 和 sandbox 的强制回收。

旧的 generic：

```text
command
rpc
web
lifecycle
instance-lifecycle
extension.call
ExtensionActivation contribution object
```

不属于 API v4。

## Host dependencies 与 sandbox

`hostDependencies` 是共享宿主 dependency tree 的显式 bare-package contract。Extension 先从自己的 immutable generation 解析模块；只有显式声明的 package root 才允许回落到宿主共享依赖。

`@portable-devshell/extension` 及其公开 domain subpath 是 Host 提供的 public SDK。其他 `@portable-devshell/*` internal package 不通过 `hostDependencies` 暴露；`.dsext` 也不能携带私有 `node_modules` 来建立第二套 package tree。

每个 activation 在独立 `worker_threads` isolate 中运行，拥有独立 V8 heap、global state 和 event loop。Runtime 对 heap/stack/external memory 设置边界，并拒绝 nested Worker、native addon、`SharedArrayBuffer`、shared WebAssembly memory、`node:vm` 新 realm 和 raw child process 等会绕过 ownership / budget 的机制。

这仍然是**执行、资源 ownership 与 fault isolation**，不是恶意代码的完整 OS sandbox。Capability 表示 portable-devshell 管理资源的 authority，不应被解释成 syscall ACL；需要运行不受信任代码时仍需要独立进程或 OS sandbox。

## Builtin Extension 映射

当前 builtin Extension 用来持续验证 public ABI：

```text
Agent
    capabilities: assets, workers, processes
    extensions: cli.native-commands, web.applications

Skill
    capabilities: assets
    extensions: cli.native-commands

Secret
    capabilities: none
    extensions: cli.native-commands

MCP Client
    capabilities: none
    extensions: cli.native-commands
```

Builtin module 不应因为自身需求扩张 core taxonomy。

## 不属于 public ABI

以下内容保持 Control/Core internal：

```text
InstanceRegistry / provider transport
Control config stores
Context / Workspace / Goal / Wait / Todo internals
Approval manager / audit writer
raw Artifact host endpoint
MCP HTTP/OAuth host internals
Worker protocol client
Worker Resource Host physical paths / private RPC
Control route framing
sandbox MessagePort protocol
```

后续新增 public Extension API 时，应先明确 domain owner、方向、lifecycle ownership 和真实 Extension 用例，再决定它是 capability、Extension Point 还是普通 domain DTO。
