# Control 管理面

portable-devshell 的 CLI、TUI 和 Web 都是同一个 Control daemon 的管理客户端。它们共享 instance registry、配置、审批、审计、Context、Todo、Artifact 和 OAuth 状态，不各自维护第二套真相。

查看总帮助或某一组命令的当前参数：

```bash
devshell help
devshell <command> --help
```

## 生命周期

```bash
devshell status
devshell start
devshell restart
devshell stop
devshell logs
```

`restart` 与简单的 `stop && start` 语义不同：它会记录当前由 Control 管理的运行中 instance，并在 Control 恢复后重新启动应恢复的 managed instance。self-managed Reverse instance 不由 Control 强制启动。

## Operational overview

```bash
devshell overview
```

返回当前 Control 的聚合视图：

```text
Control PID / uptime / system resources
instance health
active Todo
最近 tool activity
最近 24h failed/timed-out calls
pending tool approvals
pending OAuth approvals
alerts
```

健康状态是：

```text
healthy
attention
critical
```

`overview` 是实时聚合，不是另一个持久数据库。单个 collector 读取失败会产生 `overview.partial` alert，而不是让整个 overview 消失。

## 配置

```bash
devshell config get
devshell config validate <jsonDraft>
devshell config update <jsonUpdate>
devshell config instance patch <instance> <jsonPatch>
devshell config mcp patch <jsonPatch>
devshell config web patch <jsonPatch>
```

推荐通过这些 API 修改配置：Control 会 normalize、validate、preflight 并尽量 hot apply。完整字段见 [配置与运行目录](configuration.md)。

## Instance 管理

```bash
devshell instance create
devshell instance list
devshell instance status <instance>
devshell instance start <instance>
devshell instance stop <instance>
devshell instance logs <instance>
devshell instance enable <instance>
devshell instance disable <instance>
devshell instance delete <instance>
```

CLI `instance call` 是绕过 MCP Host、直接通过 Control/Core 调 worker 的诊断入口：

```bash
devshell instance call <instance> <absolute-workspace> <toolName> '<jsonInput>'
```

它仍经过 tool policy、approval、scheduler 与 audit，不是“裸 RPC 后门”。

Reverse instance 还有 device code/token 生命周期命令，见 [Reverse Worker](reverse-connections.md)。

## Watch

```bash
devshell watch status <instance>
devshell watch logs <instance>
```

`watch` 用于持续观察，而 `instance status/logs` 是一次性读取。自动化脚本需要有限输出时优先使用一次性接口，避免无界 stream。

## Tool audit

```bash
devshell tool calls <instance>
devshell tool calls <instance> <callId>
devshell tool calls <instance> --limit <n>
devshell tool calls <instance> --before <callId>
devshell tool calls <instance> --after <callId>
```

ToolCall 是跨入口统一的逻辑调用记录。内部为了实现 tmux block、artifact transfer 或兼容路由而产生的子步骤不应伪装成多条用户级 ToolCall。

记录至少用于关联：

```text
callId
instance
toolName
source
Context/workspace（存在时）
started/completed state
result or error
purpose / explanation provenance（存在时）
```

审计存储与保留策略见 [配置与运行目录](configuration.md)。

## Approval

```bash
devshell approval list <instance>
devshell approval show <instance> <approvalId>
devshell approval approve <instance> <approvalId> [--reason <text>] [--remember] [--policy-patch <json>]
devshell approval deny <instance> <approvalId> [--reason <text>] [--remember] [--policy-patch <json>]
```

审批策略和 OAuth 审批是两套不同状态机。工具执行审批见 [安全、审批与 Secret 扫描](security.md)，OAuth 见 [OAuth](oauth.md)。

## Context

```bash
devshell context list
devshell context messages <instance> [ctxId]
devshell context send <instance> <ctxId> <text>
devshell context disable <ctxId>
devshell context renew <ctxId>
```

这些命令是管理/诊断接口；模型在 `openai-session` 模式下不需要看到内部 `ctxId`。见 [Context](../concepts/context.md)。

## Todo

模型和 Workspace 使用 Todo tools 持久化任务计划；Control CLI 当前只提供显式删除：

```bash
devshell todo delete <instance> <taskId>
```

这用于人工清理已知 task，不应作为“让模型继续/停止 Goal”的替代操作。Goal/Wait 生命周期见 [Workspace](../concepts/workspace.md)。

## Artifact

公开分享、跨实例 transfer 的人工管理都在 Control plane：

```bash
devshell artifact --help
```

完整说明见 [Artifact](../tools/artifacts.md)。

## TUI

```bash
devshell tui
```

TUI 是同一 Control RPC 的交互式前端，适合：

* instance 配置/状态；
* tool approval；
* OAuth approval；
* audit/log；
* Todo 与 Artifact 状态；
* 长时间观察。

它不会把页面状态直接写进 worker；实际操作仍通过 Control service。

## Web

Web UI 由全局 `[web]` 配置控制，监听与认证独立于 MCP：

```toml
[web]
enabled = true
listenHost = "127.0.0.1"
listenPort = 17891
publicBaseUrl = "http://127.0.0.1:17891/web"
auth = "none"
```

Web 支持 `none`、`token`、`oauth2`。公网部署同样应由部署者明确选择认证和反向代理边界；Control 不根据公网/内网自动替换你的安全策略。

## Debug / Secret / Skill

这些是本机 CLI 管理能力，不进入普通 model-facing MCP catalog：

```text
devshell debug ...
devshell secret ...
devshell skill ...
```

分别见：

* [运行时 Debug Patch](../tools/debug.md)
* [安全、审批与 Secret 扫描](security.md)
* [Agent Skills](../tools/skills.md)
