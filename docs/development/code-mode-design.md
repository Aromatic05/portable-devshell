# DevShell Code Mode 设计与实施方案

本文档定义 `portable-devshell` 的 **Code Mode**（CLI 命令：`devshell code`）——基于 QuickJS-NG 的统一程序化交互接口。

Code Mode 与 CLI、MCP 并列作为 Control 之上的三大交互接口，分别承担**命令式、工具式、程序化**交互职责，共享同一套 Control 业务实现、权限边界、Hook、审批、Secret Rewrite 与审计体系。

---

## 1. 设计目标与非目标

### 目标

1. **Object-First（对象优先，而非 CLI 命令转发）**：
   - 将 Worker 工具、Control 原生管理能力与 Extension 能力统一建模为带结构化 Schema 的**对象与方法**；
   - 运行时直接执行结构化方法调用与 Handle 租约，不拼装 `argv` 字符串转发给 CLI 解析器；
   - 提供从对象定义到 CLI 子命令的投影能力，避免一套业务维护两份入口。
2. **统一实例对象模型**：
   - 全局 `devshell` 代表当前实例（在已绑定实例与工作区时）并承载 Control 级命名空间与自省入口；
   - `devshell.instance({ name | handle, workspace })` 同步返回与当前实例接口完全同构的 `InstanceHandle`，支持单次脚本内的多实例编排。
3. **安全隔离与可控执行**：
   - 在 Control 侧运行 QuickJS-NG WASM 沙箱，零隐式宿主 `fs / net / process` 能力；
   - 具备内存上限、栈深上限、并发在途调用限制、超时与 `AbortSignal` 硬中断（可终止同步死循环）及输出字节预算；
   - 所有工具调用经由 `ToolCallApi` 管线执行并携带 `parentCallId`，完整继承 Review/Approval、Secret Rewrite 与 Audit。
4. **面向人类与 Agent 的高效发现机制**：
   - 从统一对象目录的 JSON Schema 实时生成紧凑 `.d.ts`（`devshell.help()`、`devshell code --dts`）；
   - 通过 Proxy 拦截 + TypeBox 入参校验提供自愈式错误提示（直接附带正确方法签名）；
   - 支持顶层 `await` 与末尾表达式自动返回（Completion Value）。

### 非目标（本阶段不包含）

- MCP 侧工具暴露与外部 MCP server 的深度接入（预留 `model` principal、Scoped Handle 租约与 `.d.ts` 能力，在 M4 单独推进）；
- 将 Code Mode 做成 Extension（Code Mode 属于 Control 一等 Domain，拥有对 `ToolCallRegistry` 与 Control Domain Public API 的合法访问边界）；
- 为脚本提供跨请求持久化的 VM 快照或隐式默认 workspace（严格遵守 `workspace` 不持久化的架构不变量）。

---

## 2. 总体架构与 Domain 边界

```text
CLI (`devshell code ...`)  /  [M4: MCP / Web / TUI]
                    │  Control IPC (`@control:code`)
                    ▼
   packages/control/src/code/      (Control 一等 Domain)
     ├── Api.ts / Public.ts / index.ts / Route.ts
     ├── runtime/     QuickJS-NG WASM 封装、Promise Pump、Interrupt/Budget 控制
     ├── model/       DevShellRoot、InstanceHandle、Callable Namespace、Proxy 自愈层
     ├── registry/    统一对象目录（Worker ToolCall + Control Native + Extension code.objects）
     └── schema/      TypeBox 参数校验 + Schema → 紧凑 `.d.ts` 编译器 + help()
                    │
        ┌───────────┼───────────────────┐
        ▼           ▼                   ▼
  ToolCallApi   Control Domains    Extension Host
  (Worker工具    (Instance/Config   (`code.objects`
   Review/审批/   /Extension 等     结构化对象调用 &
   Secret/Audit)  Public.ts)        Scoped Handle)
```

### 包与 Domain 契约

- **`packages/shared/src/control/code/`**：跨进程 wire DTO、`code.eval` 流式消息与 `code.describe` 契约、客户端 `CodeTransport`。
- **`packages/control/src/code/`**：受 [check-domain-imports.mjs](../../scripts/check-domain-imports.mjs) 约束的新增 Control Domain；跨 Domain 依赖严格走 `Api.ts` / `Public.ts`。
- **`packages/extension/src/domain/code.ts`**（导出路径 `@portable-devshell/extension/code`）：`code.objects` Extension Point 公开契约；与 Control 侧 `ExtensionPointRegistry` / `ExtensionSandboxPointCodecRegistry` 保持 1:1 parity。
- **`packages/cli/src/command/code/`**：`devshell code` 命令解析、文件/stdin 读取、流式输出与 `SIGINT` 取消。

---

## 3. 对象模型与双权威边界

### 3.1 `DevShellRoot` 与 `InstanceHandle`

```ts
interface InstanceHandle {
    readonly name: string;
    readonly workspace: string;

    // Worker / ToolCall 投影（字段名与现有工具 100% 一致）
    readonly bash: { run(input: BashRunInput): Promise<BashRunOutput> };
    readonly file: {
        read(input: FileReadInput): Promise<FileReadOutput>;
        edit(input: FileEditInput): Promise<FileEditOutput>;
        glob(input: FileGlobInput): Promise<FileGlobOutput>;
        grep(input: FileGrepInput): Promise<FileGrepOutput>;
    };
    readonly task: {
        inspect(input: TaskInspectInput): Promise<TaskInspectOutput>;
        input(input: TaskInputInput): Promise<TaskInputOutput>;
        manage(input: TaskManageInput): Promise<TaskManageOutput>;
    };

    // 实例级 Extension 对象（如 artifact / skill / secret 等）
    readonly [extensionNamespace: string]: unknown;

    // 派生同实例其他工作区 / 显式检查可达性
    workspace(path: string): InstanceHandle;
    ready(): Promise<InstanceReadiness>;
}

interface DevShellRoot extends InstanceHandle {
    // Callable Namespace：函数调用返回同步 Lazy Handle；属性提供控制面管理方法
    readonly instance: {
        (target: { name?: string; handle?: string; workspace: string }): InstanceHandle;
        list(): Promise<InstanceSummary[]>;
        status(input: { name: string }): Promise<InstanceStatus>;
        start(input: { name: string }): Promise<InstanceLifecycleResult>;
        stop(input: { name: string }): Promise<InstanceLifecycleResult>;
        enable(input: { name: string }): Promise<InstanceLifecycleResult>;
        disable(input: { name: string }): Promise<InstanceLifecycleResult>;
        logs(input: { name: string; limit?: number }): Promise<InstanceLogEntry[]>;
    };

    readonly config: {
        get(): Promise<ControlConfig>;
    };
    readonly extension: {
        list(): Promise<ExtensionSummary[]>;
        inspect(input: { id: string }): Promise<ExtensionInspection>;
        enable(input: { id: string }): Promise<ExtensionSummary>;
        disable(input: { id: string }): Promise<ExtensionSummary>;
        reload(input: { id: string }): Promise<ExtensionSummary>;
    };
    readonly context: {
        list(): Promise<ContextSummary[]>;
    };

    // 按需自省（返回紧凑 .d.ts）
    help(target?: string, options?: { filter?: string }): Promise<string> | string;
}
```

### 3.2 关键语义

1. **同步 Lazy Handle**：`devshell.instance({ name, workspace })` 同步构造轻量不可变句柄，支持 `await devshell.instance({ name: "b", workspace: "/app" }).bash.run(...)` 链式书写；权限校验、instance 存在性检查与 worker readiness 在首次实际调用或 `await handle.ready()` 时执行。
2. **同实例派生**：省略 `name`（仅传 `{ workspace }`）或调用 `handle.workspace("/other")` 时，基于当前绑定实例派生新工作区句柄。
3. **无默认实例的 Native 行为**：DevShell 不持久化默认 instance/workspace。Native CLI 未传 `-i/-w` 时，控制面命名空间（`devshell.instance.list()`、`devshell.config.get()`、`devshell.extension.list()` 等）直接可用；调用未绑定的实例级方法会抛出清晰错误，提示传入 `-i/-w` 或改用 `devshell.instance({ name, workspace })`。
4. **双权威主体（`CodeExecutionPrincipal`）**：
   - `native`：需要 `peer === "cli"`（写操作要求 `localOwner`），允许按实例名访问已启用实例与控制面对象；
   - `model`（为 M4 MCP 预留）：绑定权威 `ctxId + primary instance + workspace`，按 `[extensions].model` 裁剪可见命名空间，`devshell.instance(...)` 仅允许解析当前 Context 可见且未被 `mask` 的 opaque handle。

---

## 4. Extension ABI：`code.objects` 与 CLI 投影

### 4.1 Extension Point 契约（`@portable-devshell/extension/code`）

```ts
export type CodeObjectScopeLevel = "control" | "instance";
export type CodeInvocationAudience = "native" | "model";

export interface CodeMethodDeclaration {
    readonly name: string;
    readonly summary: string;
    readonly inputSchema: ExtensionJsonValue;
    readonly outputSchema?: ExtensionJsonValue;
    readonly audiences: readonly CodeInvocationAudience[];
    readonly example?: string;
}

export interface CodeObjectDeclaration extends ExtensionPointDeclaration {
    readonly id: string;
    readonly scopeLevel: CodeObjectScopeLevel;
    readonly summary: string;
    readonly callable?: boolean;
    readonly methods: readonly CodeMethodDeclaration[];
}

export interface CodeObjectInvocationContext {
    readonly audience: CodeInvocationAudience;
    readonly ctxId?: string;
    readonly instance?: string;
    readonly localOwner: boolean;
    readonly parentCallId: string;
    readonly requestId: string;
    readonly signal: AbortSignal;
    readonly workingDirectory?: string;
    readonly workspace?: string;
}

export interface CodeObjectBinding {
    invoke(
        method: string,
        input: ExtensionJsonValue,
        context: CodeObjectInvocationContext,
    ): Promise<ExtensionJsonValue | undefined> | ExtensionJsonValue | undefined;
    openHandle?(
        target: ExtensionJsonValue,
        context: CodeObjectInvocationContext,
    ): Promise<string> | string;
    invokeHandle?(
        handleId: string,
        method: string,
        input: ExtensionJsonValue,
        context: CodeObjectInvocationContext,
    ): Promise<ExtensionJsonValue | undefined> | ExtensionJsonValue | undefined;
    closeHandle?(handleId: string): Promise<void> | void;
}
```

### 4.2 生命周期与 CLI 投影

- **Lazy Activation**：`devshell.help()` 与 `devshell code --dts` 只读静态 manifest 声明，不激活 Extension；首次真实调用方法时获取 generation lease 并激活。
- **Scoped Handle 回收**：执行上下文维护本次执行打开的全部 `(extensionId, objectId, handleId)`，在脚本结束、异常或中断时强制调用 `closeHandle` 并释放 lease。
- **CLI 自动投影**：`@portable-devshell/extension/code` 提供轻量 helper，将 `code.objects` 的方法与对象 Schema 投影为 CLI 子命令（解析 `--key value` / JSON 入参、生成 `--help`、渲染结果），使 Extension 以单一对象实现同时服务 Code Mode 与 CLI，同时 100% 兼容既有 `cli.native-commands` / `cli.model-commands`。

---

## 5. QuickJS-NG Runtime 与护栏

1. **WASM 同步构建 + 原生 Promise 桥接（无 Asyncify）**：
   - 使用 `quickjs-emscripten` + `@jitl/quickjs-ng-wasmfile-release-sync`；
   - WASM 模块按进程懒加载并缓存；每次 `code.eval` 创建全新 `QuickJSRuntime + QuickJSContext`，结束时完整 dispose；
   - 宿主异步调用创建 `vm.newPromise()`，与 Node Promise 桥接；每次 settle 后 drain `runtime.executePendingJobs()`，原生支持 `async/await` 与 `Promise.all` 并发。
2. **顶层 `await` 与 Completion Value**：
   - 支持直接写顶层 `await` 表达式与多语句脚本；
   - 若脚本包含显式顶层 `return`，以该值为结果；若无显式 `return` 且末尾为表达式语句，自动返回该表达式求值结果。
3. **安全与资源护栏**：
   - 默认内存上限 `64 MiB`、最大栈深 `512 KiB`、默认超时 `120_000 ms`、最大在途并发调用 `16`、单次日志与返回值字节预算（默认各 `256 KiB` 截断并标记 `truncated`）；
   - 注册 `runtime.setInterruptHandler`，外层 `AbortSignal`（CLI `SIGINT` / 超时）触发时立即打断同步死循环并向所有进行中的下游调用传播 abort；
   - 沙箱内仅注入标准 ES 内置对象、`console`、`sleep(ms)` 与 `devshell`，不暴露任何宿主文件系统、网络或进程 API。
4. **审计归因**：
   - 每次 `code.eval` 分配根 `callId`；脚本内经 `ToolCallApi` 发起的每次工具调用携带 `parentCallId`，完整经过 Review（含 Approval）、inbound/outbound Rewrite（含 Secret）与 Audit。

---

## 6. 发现、自省与自愈报错

1. **Schema → 紧凑 `.d.ts` 编译器**：
   - 统一消费 Worker ToolCall Schema、Control 原生对象 Schema 与 Extension `code.objects` Schema，按当前 principal 过滤后生成可读、低 token 的 `.d.ts`；
   - `devshell.help()` 返回顶层命名空间概览；`devshell.help("file")` 返回该命名空间的完整 `.d.ts` 与示例；`devshell.help("file", { filter: "glob" })` 按关键词过滤。
2. **Proxy 自愈层 + TypeBox 参数校验**：
   - 访问未知命名空间或方法时，报错直接列出同级可用方法与单行 `.d.ts` 签名；
   - 参数类型错误、缺少必填字段或传入未知字段时，报错明确指出具体路径与期望的 `.d.ts` 签名。

---

## 7. CLI 契约：`devshell code`

```bash
# 内联执行（控制面操作无需 -i/-w）
devshell code 'await devshell.instance.list()'

# 绑定当前实例与工作区执行
devshell code -i demo-local -w /repo '
  const [status, files] = await Promise.all([
    devshell.bash.run({ command: "git status --short" }),
    devshell.file.glob({ patterns: ["src/**/*.rs"] }),
  ]);
  return { status: status.stdout, count: files.files.length };
'

# 执行脚本文件或 stdin
devshell code workflow.js -i demo-local -w /repo
devshell code -f workflow.js -i demo-local -w /repo
cat workflow.js | devshell code -

# 导出紧凑 .d.ts 声明
devshell code --dts
devshell code --dts file
```

### 控制面路由（`@control:code`）

- Stream `eval`：推送 `{ type: "log", level, text }` 实时日志事件，最终 close 返回 `{ value, truncated, meta: { callId, durationMs, toolCalls } }`；客户端断开或 `SIGINT` 取消 stream 即中断执行。
- Unary `describe`：返回按当前权限过滤的 `.d.ts` 文本及命名空间列表。

---

## 8. 分阶段实施路线

| 阶段 | 范围与提交边界 | 核心验收 |
| --- | --- | --- |
| **M1** | `packages/shared` Code 协议与 transport；`packages/control/src/code/` QuickJS-NG 引擎、Promise 调度、护栏、Worker ToolCall 对象投影、`@control:code` 路由；`devshell code` CLI | 并发 `Promise.all`、死循环中断、内存限制、Completion Value、Approval/Secret/Audit 穿透、`devshell code` 全流程测试通过 |
| **M2** | `DevShellRoot` / `InstanceHandle` 分层、`devshell.instance(...)` Callable Namespace、Control 原生对象（`config` / `extension` / `context`）、Schema → `.d.ts` 自省与 Proxy/TypeBox 自愈层 | 无 `-i/-w` 执行 `devshell.instance.list()`、跨双实例 Handle 编排、错误方法/参数自愈提示与 `--dts` 测试通过 |
| **M3** | `@portable-devshell/extension/code`（`code.objects` + Scoped Handle）、Sandbox Codec 与 parity gate、CLI 自动投影 helper、首批 builtin Extension（`artifact` / `skill` / `recall` / `secret` / `instance`）原生对象化 | 第三方 Extension 注册 `code.objects` 自动进入 `devshell.<ext>` 与 `.d.ts`；`lazy` activation、retirement 回收、全量既有 CLI 与边界测试通过 |
| **M4（后续）** | MCP 侧 Code Mode 工具入口、Model Context 绑定、`environ_info` Layer 0 发现提示、`extensions/mcp` 原生 Handle 接入 | 保持默认 MCP 100% 兼容并支持程序化 MCP 编排 |
