# Extension ABI

portable-devshell 的 Extension 只运行在 **Control**。Worker 不加载 Extension，也不存在 native Worker plugin ABI。

当前 public ABI version 为 `2`。Builtin Extension 与独立安装的 Extension 使用同一套 ABI；Builtin 身份不提供绕过接口。

## 边界

一个 Extension 只组合三类能力：

```text
Extension
├── Control ABI
├── asset management / transfer
└── Worker control
```

Control 向 Extension 提供：

```ts
context.id
context.version
context.generation
context.paths
context.logger
context.assets
context.worker
```

Extension 向 Control 提供 contribution：

```text
command
rpc
web
instance-lifecycle
dispose
```

CLI command 的 invocation context 还可以携带 `workingDirectory`。该字段只由经过认证的 local-owner CLI 注入，表示调用者在 Control 主机上的工作目录；远程 CLI 不能声明它。依赖 Control 本地 project 路径的 Extension 必须使用这个字段，而不能读取 Control daemon 自己的 `process.cwd()`。

`context.*` 与 contribution 的方向不能混用：前者是宿主能力，后者是 Extension 对宿主提供的入口。

## Assets

`context.assets` 管理 Extension 自己拥有的不可变资产 generation：

```text
installBundle
installDirectory
listBundles
resolveBundle
removeBundle
transferBundle
```

`generation` 是 opaque identity，Extension 不得解析它，也不得依赖 Control 的物理目录布局。`resolveBundle()` 返回的目录只表示该 generation 当前可用的位置；Extension 不应由它推导兄弟 generation 或 Control 内部路径。

资产语义属于 Extension。例如 Agent 决定哪个 generation 是 Pi provider，Skill 决定哪个目录是一项 Skill。Control 只负责安全物化、内容寻址以及传输。

资产跨机器时复用 Artifact 基础设施。Extension 只指定已安装的 generation 和目标：

```text
generation
  -> Control resolves owned source
  -> Artifact transfer
  -> target Worker
```

Extension 不能通过 asset API 指定任意 Control host source path，因此 asset transfer 不是 host filesystem 读取旁路。

## Worker control

`context.worker.openSession()` 是 Extension 唯一的 target execution 入口：

```ts
openSession({
    instance?,
    workspace
})
```

Session 提供：

```text
environment
instance
workspace
listTools
callTool
close
```

`environment` 是 Worker handshake 的稳定只读投影，目前只包含：

```text
homeDirectory
platform
```

业务资源目录不进入通用 ABI。比如 Skill 的 managed 目录由 Skill Extension 自己根据目标 home 和自身约定管理，Worker ABI 不理解 Skill。

不暴露 `WorkerInstance`、Worker protocol client、SSH/Docker/Reverse transport、RPC framing 或 connection lease。

工具调用仍经过正常的 approval、scheduler 和 audit pipeline，并以 `source=extension` 和 Extension id 归因。

## Capability

Manifest 显式声明使用的 capability：

```text
assets
command
instance-lifecycle
rpc
web
worker
```

未声明的宿主能力必须在使用前拒绝。Capability 是 public API grant，不是 OS sandbox；当前 Extension JavaScript 仍运行在受信任的 Control 进程中。

## 不属于 public ABI 的能力

以下内容保持 Control/Core internal，不为某个 builtin module 扩张 public ABI：

```text
InstanceRegistry / provider transport
Control config stores
Context / Workspace / Goal / Wait / Todo internals
Approval manager / audit writer
raw Artifact host endpoint
MCP HTTP/OAuth host internals
Worker protocol client
```

MCP Server 因此是 builtin module，而不是 public Extension。Agent、Skill 等 builtin Extension 则应严格通过 public ABI 工作，用它们来持续验证 ABI 的完整性。
