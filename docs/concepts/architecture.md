# 系统架构

这份文档以 `1.0.0-rc.1` 候选源码和运行时边界为基线，不保留已经被替换的早期方案；RC 发布状态以 GitHub Release 为准。

## 总体结构

```text
CLI / TUI / Web / MCP Host
          │
          ▼
TypeScript Control daemon
  ├── config + instance registry
  ├── audit / approval / goal
  ├── Context + Workspace state
  ├── physical HTTP Listener + revocable leases
  ├── MCP v2 / OAuth routes
  ├── Artifact share / transfer
  └── provider lifecycle
          │
          ▼
packages/core WorkerInstance
          │
          ▼
provider transport
  ├── local
  ├── ssh
  ├── docker
  ├── podman
  └── reverse
          │
          ▼
Rust devshell-worker daemon
  ├── bash
  ├── file
  ├── tmux
  └── artifact payload
```

CLI、TUI、Web 与 MCP 都是 Control 的 client。它们不各自维护真实 instance 状态，也不绕过 Control 直接管理 worker。

## TypeScript package 边界

当前仓库的主要 package：

```text
packages/shared   wire types、error、schema、公共数据结构
packages/core     WorkerInstance、RPC、provider-neutral 工具调用链
packages/control  daemon、配置、instance 生命周期、持久状态、审计
packages/extension  Control Extension public ABI
packages/mcp      MCP endpoint、Workspace App、OAuth、注入式 HTTP route/lease
packages/cli      Control CLI、instance/config/debug/skill/artifact 管理
packages/tui      终端 UI
packages/web      Web 管理面
crates/devshell-worker  目标环境 Rust worker
```

依赖方向的基本原则是：上层入口依赖 Control/Core，worker 不反向依赖 MCP/CLI/UI。

## Domain 模块边界

- Core 与 Control 中具有 Runtime 生命周期的 Domain 以各自根目录的 `index.ts` 组装本 Domain 的实现；`Api.ts` 向其他 Domain 提供类型，`Public.ts` 提供允许跨 Domain 调用的运行时接口。这三个入口不可互相取代。
- `Route.ts` 提供 Domain 的 host/port 路由适配与组装；供其他 Domain 使用时经 `Public.ts` 导出，不替代 in-process API。
- `packages/core/src/instance` 是组合根，可以通过其他 Domain 的 `index.ts` 创建 Runtime，再连接 Hook 和生命周期；其他跨 Domain 调用遵循 `Api.ts` / `Public.ts` 契约，而不是直接导入私有子目录。
- Control 的 Extension Config Capability 经由 `packages/control/src/config/Api.ts`、`Public.ts` 使用 Config 相关接口。Config 负责持久化、权限与 Domain 注册，Extension 只提供 Capability 适配。
- TUI 的 State 和 Interaction 不依赖 View 实现。Interaction 通过注入的 `TuiInteractionProjection` 获取需要的页面投影；公共尺寸算法属于 `terminal`，Context、Draft 与导航状态属于 `state`。Terminal Controller 的渲染几何读取是单独的终端适配职责。
- Web 前端以 `main.tsx` 启动，并由 App 组装 View、Domain Session 与 State。Web State 和 Domain Session 不反向依赖 View。并非每个前端组织目录都是需要 `index.ts` 的 Runtime Domain。
- Worker 的 Sandbox 独立提供 `PathError`，由 Tool / RPC 边界转换成外部错误类型。Tool 通过进程生命周期接口和进度回调接收 Worker 能力；RPC 负责将进度编码为通知，不反向进入 Tool 契约。

已识别 Domain 根和跨层边界由 `scripts/check-domain-imports.mjs` 检查；新增 Domain 时要同步维护该规则及其正反例测试，不通过生成空入口文件替代 Domain 组装。

## Instance

instance 是一个受 Control 管理的目标环境描述：

```text
name
provider
provider config
security / approval config
execution environment / sandbox providers
MCP endpoint config
model Extension ACL
Workspace feature switch
enabled state
```

instance **不持久化默认 workspace**。

workspace 是操作级或 Context-level authority：

- CLI `instance call` 显式传 worker 上的绝对 workspace；
- MCP `environ_info` 在 Context 中为当前 instance 建立 environment attachment；
- model-facing `devshell instance list/status` 为当前 Context 可见的 remote instance 返回 opaque handle；
- fixed MCP `environ_remote(command="attach")` 使用 handle 在同一个 Context 下附着另一个 instance/workspace；`mask` 对当前 Context 永久撤销该 remote instance 的访问；
- TUI 的人工 terminal 入口可以使用 worker handshake 报告的用户 home 作为交互起点，但这不写回 instance config。

`execution.environment[]` 按 `order` 配置 `{ name, content, phase? }`，`execution.sandbox` 配置 `{ name, content, phase? }`；`phase` 为 `daemon` 或 `process`，由对应 Extension execution provider 处理。它们属于 instance 执行配置，不是 workspace 路径。

`[workspace].enabled` 只控制 Workspace App/Goal/Wait recovery 子系统，不是默认 workspace path。

instance 配置保存在：

```text
~/.devshell/control/instances/<instance>.toml
```

当前 instance config version 为 `4`。实例名必须包含连字符，例如 `demo-local`。

## Worker

worker 是目标环境上的独立 daemon。Control 通过 provider 完成：

```text
install / locate
start / stop
handshake
schema discovery
RPC
logs
replacement / reconnect
```

Worker transport 使用长度定界 Protobuf Envelope，包含 source/dest 的 host + port 地址。普通 RPC/Event/Stream control packet 的 JSON 在 Envelope 内部；Stream DATA 二进制使用专用 bytes 字段。直接 daemon RPC IPC 的 JSON codec 与这条 transport 不应混为一谈。环境握手与工具发现分开：

```text
worker.handshake
tools.list
```

工具 schema 来自目标 worker，因此不同版本或平台可以暴露不同能力。Core 会缓存足够的 schema/compatibility 信息，使短暂 worker 不可用或热升级期间的 MCP catalog 不至于突然破坏 Host 已缓存的 recipient。

## Core 工具调用链

Control ToolCall Registry 将 definitions、hooks 与 executors 同步安装到各 Instance；每个 Instance 持有自己的共享 ToolCall pipeline 与执行 target。当前主要路径是：

```text
ToolCallApi.call
  -> inbound Review（含 Core Approval，首个 reject 停止）
  -> inbound Rewrite
  -> 按改写后的 instance/toolName 解析 Target / Execute callback
  -> Target Audit scope / input preparation / readiness
  -> Scheduler reserve / queue / Execute（callback 或 Worker）
  -> transformResult
  -> outbound Rewrite / Review
  -> terminal Audit（host recording）
  -> caller
```

Review 只有 `continue` / `reject`；人工审批由 Review hook 自行等待，不存在 Extension `approve` 决定。等待审批时尚未取得这里的 Scheduler reservation。Rewrite 可替换完整调用值，包含工具、路由和 payload；Host 保留 principal、externalBindings、contextMode、extensionId。两方向都按 hook / id / owner 稳定升序执行，不自动反序。inbound Rewrite 也可直接产生终态而不进入 Execute。

Execute 完成、结果发布完成与 Audit 持久化完成是不同事实，没有统一原子 Commit。Audit input 来自 inbound Rewrite 后的值；部分审计失败会 abandon 记录并保留执行结果，不能把审计成功当作执行前提。`recording = "caller"` 时 Target 不承担 host Audit。

**执行后错误与回归：**早期 `postExecution` 错误可能错误保留 `retryable: true`，该历史偏差已由 [ToolCallAdapterRetryAfterCommitRound6](../../packages/core/test/unit/tool/ToolCallAdapterRetryAfterCommitRound6.test.ts) 在当前普通测试路径检查：真实副作用写入后适配失败应标记 `executionCompleted=true`、`failureStage=postExecution` 和 `retryable=false`。outbound hook delivery failure 也应为 `outboundHook`、`retryable: false`。调用方不能凭 failed 推断无副作用，也不能自动重试已完成执行。

Secret Extension 使用 Rewrite 展开输入引用并 mask 输出；Host interface 仅向 Secret 提供当前 instance、当前 payload 引用与本次已使用名字对应的 env，不提供任意枚举能力。每次 interface 请求读取当时配置，并非调用全程固定 snapshot；Audit 不能被描述为必然只记录展开前 secret 引用。Comment advice/delivery 写入结果 `payload.comment`，不使用旧 `feedback[]` side-channel。outbound 遇到已退休 Rewrite generation 时可重新绑定同 owner registration，已开始的 hook 不重放。

审批不是 MCP 专属功能；CLI/TUI/MCP 共享同一套策略。

取消通过 RPC 传播到支持取消的 worker operation，但取消不是回滚协议。具体工具决定已经完成的原子子操作是否保留。

## MCP

每个启用 MCP 的 instance 对应：

```text
/<instance>/mcp
```

当前 MCP server 使用 SDK v2 `createMcpHandler`，提供 2026-07-28 stateless per-request handling；两个 handler 均为 `legacy = "reject"`，不接受旧协议 fallback。除 `environ_info` 外的 `tools/call` 使用 SSE / 1 秒 keepalive，其他请求使用 auto / 15 秒 keepalive。Context 是独立应用状态。

工具 catalog 合并 Worker schema、固定 Control runtime primitives 与 Extension `mcp.tools` 声明。Extension contribution 变化会同步目录和 executor；instance group/capability policy 不裁剪 `tools/list`。Context-bound `devshell` shim 的 `cli.model-commands` 则由 `[extensions].model` 单独授权。

Control 按 host:port 持有物理 HTTP Listener，MCP、Web、Artifact 与 Reverse 使用可撤销 lease。同地址可复用 Listener；最后一个 active lease stop 才关闭底层监听，`dispose` 永久撤销该 consumer 的 routes。单个 consumer 退役不等于关闭共享 Listener。

详见 [MCP](mcp.md)。

## Context

Context 是由 Control 管理的应用级状态 key，不是 MCP session。权威实现集中在 `packages/control/src/context/`；MCP 使用注入的 Context 能力，不拥有 Registry 或 Context 生命周期。

`environments[]` 是唯一当前关联来源。每条关联明确 instance 与可选 workspace；删除 Instance 只解除关联，即使没有剩余关联也不终止 Context。

```text
ctxId
  ├── principal
  ├── external Host bindings
  ├── environments per instance
  ├── Goal / Wait / Approval / Memory ownership
  └── execution + re-entry state
```

`explicit` 和 `openai-session` 只是两种 MCP selector；内部子系统始终围绕 Context 工作。

详见 [Context](context.md)。

## Workspace

Workspace scope 是 instance 与 Worker canonical path 的组合，可以由多个 Context 关联；它不是 Context 独占的目录资源。

Workspace App 是 Context 上的交互/恢复层，不是另一份 workspace 关联权威：

```text
MCP App presentation
Goal
Memory checkpoint
Approval
durable Wait
automatic model re-entry
```

它使用 authoritative server snapshot；App 只负责呈现和用户动作。Control/MCP/iframe 重启时，durable state 与 task state独立恢复。

详见 [Workspace](workspace.md)。

## tmux task 与 Context 解耦

managed tmux task 属于 worker/runtime，不属于某个 HTTP request 或 Context 生命周期。

因此：

```text
MCP connection close
Context refresh
Workspace remount
Control/MCP transport reconnect
```

都不会自动杀掉已经启动的 task。

Context/Workspace 只负责“谁在等待这个 task、任务完成后是否应该重新进入模型”。

## Artifact

Artifact 有三层：

```text
worker artifact handle
Control view/share
cross-instance transfer
```

stdout/stderr 等 worker-local artifact 通过 handle 延迟读取；bulk bytes 使用 `artifact` port 的 Packet Stream：`payload.read` 读取 bytes，再从 close message 获取 totalBytes、offset 和 EOF 等 metadata；`receive.write` 写 bytes、finish 输入并等待 close metadata。没有旧 8-byte totalBytes header。open/begin/finish/close 等生命周期仍使用该 port 的 RPC。图片可以由 Control 转成原生 MCP image content；公开 share 和跨实例 transfer 由 Control 管理配额、lease、hash 与 lifecycle。

详见 [Artifact](../tools/artifacts.md)。

## Reverse provider

Reverse worker 主动连接 Control：

```text
WSS
  └── fallback: SSE downstream + HTTPS POST upstream
```

两种 carrier 都归一为 Channel，转发到 daemon transport endpoint；Reverse 不按 RPC method 划分 lane。当前传输结构为：

```text
Provider / Carrier -> Channel
  -> Frame v1（单个 envelope service stream）
  -> Endpoint / Route（host + port）
  -> length-delimited Protobuf Envelope
  -> Rpc / Event / Stream Packet
```

CLI↔Control 与 Core↔Worker 共享 Endpoint/Envelope/Packet 基础设施，但 Control hello、admission 与业务 port 的权限契约独立。应用 Stream 在 Packet 层复用，不能把它们画成多个 Frame service。

连接断开会使未完成 RPC 的结果 uncertain、不可自动重试；重连建立新连接，不自动 replay ToolCall。必须先检查操作状态再决定是否重新发起请求，不能依赖旧 `worker.rpc` terminal-response cache 保证。self-managed Reverse Worker 不由 Control 启动，删除 Control registration 也不等于清理远端 daemon/tmux 数据。

详见 [Reverse Worker](../operations/reverse-connections.md)。

## 持久化边界

主要持久化目录：

```text
~/.devshell/control/       Control config/state/audit/context/oauth
~/.devshell/<instance>/    instance runtime state
~/.devshell/workers/       installed worker generations
<data-home>/portable-devshell/extensions/       Extension code generations
<data-home>/portable-devshell/extension-data/   Extension data
~/.devshell/control/extensions/registry.json    Extension registry
~/.devshell/control/extensions/state/<id>/      Extension state/config.json
<runtime-root>/extensions/                      transient activation runtime
```

`data-home` 默认是 Unix `$XDG_DATA_HOME` 或 `~/.local/share`；Windows 使用 `$XDG_DATA_HOME` 或 `%LOCALAPPDATA%`。

高频、可重建状态尽量不写成永久历史。例如 Context execution sidecar、临时 workspace data、tmux volatile runtime 会使用专门的 bounded/transient storage，而不是无限增长 Control 主状态文件。

Control IPC：

```text
Linux/macOS  $XDG_RUNTIME_DIR/portable-devshell/control.sock
Windows      \\.\pipe\portable-devshell-control-<user>
```

## 设计原则

1.0.0-rc.1 候选架构可以归纳为：

1. **Control owns lifecycle; Worker owns execution.**
2. **Context owns Agent continuity; transport does not.**
3. **Workspace owns recovery; tmux task does not depend on Workspace.**
4. **CLI/TUI/MCP share one authority path.**
5. **Model-facing schema stays small; Control-plane management stays out of the model catalog.**
6. **Compatibility is hidden at the wire boundary, not reintroduced into new product semantics.**
