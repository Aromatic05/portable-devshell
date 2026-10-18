# 系统架构

这份文档以当前 `1.0.0-beta.1` 代码和运行时边界为基线，不保留已经被替换的早期方案。

## 总体结构

```text
CLI / TUI / Web / MCP Host
          │
          ▼
TypeScript Control daemon
  ├── config + instance registry
  ├── audit / approval / todo
  ├── Context + Workspace state
  ├── MCP v2 / OAuth HTTP host
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
packages/mcp      MCP endpoint、Workspace App、OAuth、HTTP integration
packages/cli      Control CLI、instance/config/debug/skill/artifact 管理
packages/tui      终端 UI
packages/web      Web 管理面
crates/devshell-worker  目标环境 Rust worker
```

依赖方向的基本原则是：上层入口依赖 Control/Core，worker 不反向依赖 MCP/CLI/UI。

## Domain 模块边界

- Core 与 Control 中具有 Runtime 生命周期的 Domain 以各自根目录的 `index.ts` 组装本 Domain 的实现；`Api.ts` 向其他 Domain 提供类型，`Public.ts` 提供允许跨 Domain 调用的运行时接口。这三个入口不可互相取代。
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

worker RPC 使用长度前缀 JSON frame。环境握手与工具发现分开：

```text
worker.handshake
tools.list
```

工具 schema 来自目标 worker，因此不同版本或平台可以暴露不同能力。Core 会缓存足够的 schema/compatibility 信息，使短暂 worker 不可用或热升级期间的 MCP catalog 不至于突然破坏 Host 已缓存的 recipient。

## Core 工具调用链

所有入口最终进入同一条 ToolCall pipeline：

```text
input
  -> route / context workspace
  -> policy + capability
  -> approval
  -> scheduler / queue
  -> audit
  -> worker RPC or Control-owned operation
  -> result / error hints
```

审批不是 MCP 专属功能；CLI/TUI/MCP 共享同一套策略。

取消通过 RPC 传播到支持取消的 worker operation，但取消不是回滚协议。具体工具决定已经完成的原子子操作是否保留。

## MCP

每个启用 MCP 的 instance 对应：

```text
/<instance>/mcp
```

当前 MCP server 使用 SDK v2 `createMcpHandler`：

```text
2026-07-28 modern request
  -> stateless per-request handling

2025-era request
  -> stateless legacy fallback
```

长 `tools/call` 使用 request-scoped SSE + 15 秒 keepalive。这样 transport 可以保持真实阻塞，同时不依赖 protocol session 来承载 portable-devshell 应用状态。

工具 catalog 由 Worker tools 与固定的 Control-owned runtime primitives 合并形成稳定目录；instance 配置不再用 group/capability policy 动态裁剪 `tools/list`。可扩展的 model command 通过 Context-bound `devshell` shim 与 `cli.model-commands` 单独授权。

详见 [MCP](mcp.md)。

## Context

Context 是由 Control 管理的应用级状态 key，不是 MCP session。权威实现集中在 `packages/control/src/context/`；MCP 使用注入的 Context 能力，不拥有 Registry 或 Context 生命周期。

`environments[]` 是唯一当前关联来源。每条关联明确 instance 与可选 workspace；删除 Instance 只解除关联，即使没有剩余关联也不终止 Context。

```text
ctxId
  ├── principal
  ├── external Host bindings
  ├── environments per instance
  ├── Todo / Goal / Wait / Approval ownership
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
Todo checkpoint
Question
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

stdout/stderr 等 worker-local artifact 通过 handle 延迟读取；payload/receive 的 bulk bytes 使用 Worker Frame Service，open/begin/finish/close 等生命周期仍走 Worker RPC。图片可以由 Control 转成原生 MCP image content；公开 share 和跨实例 transfer 由 Control 管理配额、lease、hash 与 lifecycle。

详见 [Artifact](../tools/artifacts.md)。

## Reverse provider

Reverse worker 主动连接 Control：

```text
WSS
  └── fallback: SSE downstream + HTTPS POST upstream
```

两种 transport 都归一为一条 Channel，再由 Frame v1 multiplex `worker.rpc`、Artifact、TCP、process 等 Service。generation 属于 Reverse Channel 生命周期；只有 `worker.rpc` Protocol 使用 request replay 与有界 terminal-response cache 在重连后避免同一个逻辑请求被重复执行；成功与失败 terminal response 都参与 exact replay，其它 logical stream 不跨 generation 恢复。

self-managed reverse worker 不由 Control 启动；Control 只接受其连接并管理引用/路由。

详见 [Reverse Worker](../operations/reverse-connections.md)。

## 持久化边界

主要持久化目录：

```text
~/.devshell/control/       Control config/state/audit/context/oauth
~/.devshell/<instance>/    instance runtime state
~/.devshell/workers/       installed worker generations
```

高频、可重建状态尽量不写成永久历史。例如 Context execution sidecar、临时 workspace data、tmux volatile runtime 会使用专门的 bounded/transient storage，而不是无限增长 Control 主状态文件。

Control IPC：

```text
Linux/macOS  $XDG_RUNTIME_DIR/portable-devshell/control.sock
Windows      \\.\pipe\portable-devshell-control-<user>
```

## 设计原则

当前 1.0.0-beta.1 架构可以归纳为：

1. **Control owns lifecycle; Worker owns execution.**
2. **Context owns Agent continuity; transport does not.**
3. **Workspace owns recovery; tmux task does not depend on Workspace.**
4. **CLI/TUI/MCP share one authority path.**
5. **Model-facing schema stays small; Control-plane management stays out of the model catalog.**
6. **Compatibility is hidden at the wire boundary, not reintroduced into new product semantics.**
