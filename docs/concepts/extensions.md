# Extension ABI

portable-devshell 的 Extension 运行在 **Control**。Worker 不加载 Extension，也不存在 native Worker plugin ABI。

当前 public Extension API version 为 `3`。Builtin Extension 与独立安装的 Extension 使用同一套 ABI；builtin 身份不绕过 capability、registration、sandbox 或 generation ownership。

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
    "apiVersion": 3,
    "id": "example",
    "name": "Example",
    "version": "1.0.0",
    "entry": "index.js",
    "hostDependencies": [],
    "capabilities": ["assets", "workers"],
    "extensions": {
        "cli.commands": [
            { "id": "example", "title": "Example" }
        ]
    }
}
```

`capabilities` 只包含宿主管理资源类别。当前集合是：

```text
assets
workers
processes
```

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
import { commands } from "@portable-devshell/extension/cli";

export function activate(context: ExtensionContext): void {
    context.register(commands, "example", async (argv, invocation) => {
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
cli.commands
web.applications
```

Registration 使用 Extension-local id；Host 结合 point id、Extension id 和 local id 建立全局 identity。Runtime registration 默认属于当前 generation，generation retirement 自动撤销。

Public SDK 按 domain subpath 发布 leaf contract：

```text
@portable-devshell/extension
@portable-devshell/extension/cli
@portable-devshell/extension/web
```

root 只导出 core ABI；CLI/Web domain contract 不从 root 聚合，也不要求 Extension 依赖完整 CLI/Web runtime package。

### cli.commands

`@portable-devshell/extension/cli` 当前公开：

```text
commands
CliCommandDeclaration
CliCommandBinding
CliCommandResult
```

Declaration 可以提供 `title`、`summary` 和 `usage`。Binding 当前由 CLI domain 定义为 argv + invocation context -> CLI result；这是 CLI 自己的 contract，不是 generic Extension RPC。

Control 内部 static catalog 会由 CLI domain 投影成 command discovery DTO。该 discovery 只包含 CLI presentation metadata，不包含 generation 或 runtime binding。`devshell <extension-command> --help` 使用这一静态数据生成 help，因此查看 Extension command 帮助不会 activation Extension；普通 argv 仍按需取得 generation lease 并调用真实 binding。全局 `devshell --help` 不依赖 Control，保持本地可用。

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

不属于 API v3。

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
