# 安全、审批与 Secret 扫描

portable-devshell 不把安全边界压缩成一个“safe mode”。权限来自多层组合：

```text
OS user / Control socket
provider identity
MCP/Web auth
MCP tool catalog / model Extension command allowlist
workspace security mode
approval policy
Context / app capability
具体工具自己的路径与输入校验
```

## Tool approval policy

每个 instance 可以配置 `approvalPolicy`。

模式：

```text
disabled
allow
ask
deny
```

语义：

- `disabled` 与 `allow` 的默认决策都是直接允许；
- `ask` 创建 pending Approval，调用等待人工决定；
- `deny` 默认拒绝；
- `rules` 按配置顺序 first-match，命中后覆盖 mode 的默认决策。

Rule 当前使用 exact match：

```text
match = exact
source = all | cli | tui | web | mcp | extension
toolName = 可选的精确工具名
decision = allow | ask | deny
```

source 不匹配或 toolName 不匹配时继续下一条 rule。

pending Approval 默认有有限生命周期；当前 Core 默认 timeout 为 5 分钟。超时、调用取消、Control 重启时孤立的旧 pending request 都不会无限期保持成一个可执行授权。

当前 ToolCall pipeline 把 Approval 实现为 Core `510-approval` Review hook：在 inbound Rewrite 前评估或等待人工决定。Review 只有 `continue/reject`；Extension 不能返回“approve”来授予权限。审批等待尚未取得 target Scheduler reservation，但持有 Instance ingress 生命周期 lease。

Approval 检查的是改写前的工具与输入摘要。之后完整值 Rewrite 可改变 toolName、instance、Context/workspace 和参数，Runtime 不会重新执行 Review/Approval。Host 单独保留 principal、external session bindings、contextMode、extensionId，防止 Extension 通过 Rewrite 伪造这些字段；这不能替代工具与 Context 自身的权限检查。详见 [ToolCall Boundary](../development/toolcall-boundary.md)。

## 人工审批

CLI：

```bash
devshell approval list <instance>
devshell approval show <instance> <approvalId>
devshell approval approve <instance> <approvalId> [--reason <text>] [--remember] [--policy-patch <json>]
devshell approval deny <instance> <approvalId> [--reason <text>] [--remember] [--policy-patch <json>]
```

TUI/Web 也可以处理 Approval，`decidedBy` 会记录来源。

`remember` / `policyPatch` 属于显式策略变更；一次 approve 本身不应悄悄变成永久 allow rule。

Approval record 包含 `callId`、tool、source、input summary、risk level、Context/workspace（存在时）和最终 decision。Approval 的 pending/decision 记录与 target ToolCall Audit 生命周期是不同记录；后者不能保证每次都持久化成功。

## OAuth approval 不等于 Tool approval

OAuth registration/authorization 只决定某个 MCP client 是否获得 access token；拿到 token 后实际 tool call 仍要经过：

```text
Worker tool namespace / tool-specific constraints
workspace/path security
approval policy
```

反过来，批准一个 Tool Approval 也不会授予新的 OAuth scope。

见 [OAuth](oauth.md)。

## `security.mode`

当前 instance security mode：

```text
disabled
workspace
```

`workspace` 让支持该模式的 worker/path 操作受当前显式 workspace authority 限制。它与 Approval 不同：workspace security 是可执行范围，Approval 是是否允许当前调用继续。

`disabled` 不代表“忽略所有安全检查”；工具自身的类型、路径、symlink、namespace、auth 等检查仍然存在。

## Secret 扫描

Builtin Secret Extension 同时声明 native command、model command 和 ToolCall Rewrite。扫描返回 finding metadata；Rewrite 注入/遮蔽凭据，两者不是同一条数据流，也不具有相同的保密保证。

两种扫描入口使用相同命令形式：

```bash
devshell secret scan [directory] [--glob <pattern>] [--limit <n>]
```

| 入口 | 权限与文件位置 | 路径边界 |
| --- | --- | --- |
| 本机 native CLI | 仅 local-owner；由 Control 主机上的 Secret Extension 读取本地文件 | 支持绝对目录；相对目录基于 CLI 传入的 workingDirectory，不是 Worker workspace |
| 模型命令 | 受 instance 的 model Extension command 授权限制；用 `worker.execute` 在 invocation 指定的 instance/workspace 打开 session | 仅当前 Worker workspace 内相对目录；拒绝绝对路径、反斜杠、空段、`.`/`..` 路径段（根目录 `.`/`./` 除外） |

模型命令 broker 还验证 active Context 的 instance/workspace attachment 及所属 MCP parent ToolCall 的 provenance，模型不能任意选择扫描主机。模型入口通过 Worker `file_glob` 分页发现文件，再按每批最多 32 个文件调用 `file_read`，读取的内容进入 Secret 扫描逻辑。扫描文件可能位于远程 Worker，不能声称内容只在 Control 主机本地读取或不经过 Worker transport。模型拿到的正常扫描结果只含 finding metadata，不包含命中值或原文件内容。

例如两个入口的成功结果都使用：

```json
{
    "findings": [
        { "type": "github_token", "path": "config/example.txt", "line": 12 }
    ],
    "truncated": false,
    "truncatedFiles": 0
}
```

每条 finding 只有 `type/path/line`，不返回匹配值。这个保证限定于扫描结果格式，不是对内部 Worker 读取、所有日志、Audit 或其他工具输出的统一保密承诺。

检测类别包括 GitHub token、AWS access key 形态、private key header、常见 token/secret/password/api_key 字符串赋值。Generic assignment 会过滤常见 placeholder，减少示例配置误报。

### Discovery 与截断

Native 扫描当前使用内置 walker，没有按 `rg` 是否存在切换的分支。它按分层 ignore scope 处理 `.gitignore/.ignore`（包括 negation），跳过 `.git/.hg/.svn/node_modules` 目录；符号链接目录项不是普通文件/目录，不沿其遍历。不可读取的 candidate 会跳过。

| 限制 | Native | Model |
| --- | --- | --- |
| findings 默认/最大 | 200 / 1000 | 200 / 1000 |
| 最多发现文件 | 20000 | 收集最多 20000 个匹配路径 |
| traversal entries | 50000 | 由 Worker `file_glob` 的发现规则决定 |
| 文件读取 | 最多前 1 MiB；含 NUL 的内容跳过 | 使用 Worker `file_read` 返回内容及其 truncated 标记 |
| `truncatedFiles` | 读取超过 1 MiB 的文本计数 | Worker 返回 `truncated=true` 的文件计数 |

不能将 native walker 的 ignore、二进制过滤、1 MiB 限制直接当成模型入口契约。Model 不另做同样的本地读取，scan 只处理 Worker 实际返回的文本，并去掉 `file_read` 行号前缀。`truncated=false` 也不是全仓库完整扫描证明。

`--glob` 筛选相对扫描目录的路径，例如：

```bash
devshell secret scan . --glob '**/*.toml'
```

### Secret scan 的边界

这是轻量 preflight：pattern 可以漏报或误报，发现、读取和 findings 限制会截断结果；不检查 Git 历史、远程 secret manager 或已删除文件。不能替代专业 secret scanner 或仓库历史审计。

实现：[native command](../../extensions/secret/src/builtin/command/SecretCommand.ts)、[model command](../../extensions/secret/src/builtin/command/SecretModelCommand.ts)、[scanner](../../extensions/secret/src/builtin/scan/SecretScan.ts)。

## Secret 的 ToolCall Rewrite

`toolcall.rewrite / secret`（hook `100-secret-mask`）在 inbound payload 的字符串值中展开 `${SECRET:NAME}`，从当前 hook 的 `context.instance` 对应 env 获取值；引用的名字未配置在 env 中会使 expand 失败。它不把所有 instance env 都解释为 Secret，也不修改对象 key。

Secret 没有 config/env 枚举 capability。Control 仅向 builtin owner `secret` 提供单次调用 scope 内的 `secret.environment` interface：

- inbound 接受 `{ names: [...] }`，验证每个名字的 placeholder 存在于当前完整 payload，只返回对应存在的 env 条目，并记录成功解析的名字；
- outbound 不接受 input，只返回本 scope 已解析名字对应的当前 env 条目；
- interface 不接受独立 instance 参数，使用当前 hook value 的 instance；该字段可能已被前序 Rewrite 改写。

scope 保存名字，不保存 inbound value。每次请求都会重新读取 live config；不能承诺同一调用 inbound/outbound 使用固定 env snapshot。普通 `LANG` 等未通过 placeholder 解析的 env 不会进入 mask set。

Secret 对正常 outbound result/error/progress 的字符串值做 masking：非空值优先匹配较长值，相同 value 使用稳定名字选择 canonical placeholder，已知 placeholder 不重复展开。两方向 Rewrite 都按 hook/id/owner 升序运行；Secret 不是反序栈中的最终出口，后续 hooks 增加的内容不会再次通过 Secret。

**KNOWN 未解决安全偏差：** 当前 target 在 inbound Rewrite 后创建 Audit scope，input 与 inputSummary 可能含已展开的真实 Secret；旧的“Audit 永远只保存 placeholder”保证不成立。env 轮换或删除后，outbound 读取的新 env 可能无法遮蔽旧值；后续 Rewrite 也可能重新引入敏感内容。目标仍是阻止真实 Secret 进入持久化及模型可见通道，这些偏差未因本次文档修订得到修复，不能将扫描结果不含匹配值推广为 ToolCall 全链路安全保证。

## Audit 与执行后失败

ToolCall 默认由 host 记录；`recording=caller` 将记录责任交给 caller。当前 host Audit 是尽力记录，多处存储异常会 abandon active record 并保留执行结果，因此存在丢失或不完整记录的未解决缺口。执行、结果形成、传输 delivery 与 Audit 持久化没有统一原子提交。

Outbound hook 失败时，target 不暴露 raw result，不重跑已失败的 Rewrite；执行已完成时返回 `core.toolResultDeliveryFailed`，`executionCompleted=true`、`failureStage=outboundHook`、`retryable=false`。

**历史缺陷已纳入回归：**早期 `transformResult` 在执行后失败时保留原错误的 `retryable=true`。当前 [ToolCall Adapter 回归](../../packages/core/test/unit/tool/ToolCallAdapterRetryAfterCommitRound6.test.ts) 会产生实际副作用再触发适配失败，验证最终不可重试、执行完成标记和 Audit 归属。本轮在 2026-10-26 独立运行该回归通过。调用方仍不能只凭 failed 状态推断操作没有副作用；取消也不代表回滚。详情参见 [ToolCall Boundary](../development/toolcall-boundary.md)。

## Runtime Debug Patch

`devshell debug` 只允许本机 owner Control socket，并要求 Context scope。它能改变匹配调用的运行行为，因此虽然设计为可回滚保护模式，也只应被当作开发调试能力。

见 [运行时 Debug Patch](../tools/debug.md)。
