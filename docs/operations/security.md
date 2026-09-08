# 安全、审批与 Secret 扫描

portable-devshell 不把安全边界压缩成一个“safe mode”。权限来自多层组合：

```text
OS user / Control socket
provider identity
MCP/Web auth
tool group + capability
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

* `disabled` 与 `allow` 的默认决策都是直接允许；
* `ask` 创建 pending Approval，调用等待人工决定；
* `deny` 默认拒绝；
* `rules` 按配置顺序 first-match，命中后覆盖 mode 的默认决策。

Rule 当前使用 exact match：

```text
source = all | cli | tui | mcp | ...
toolName = 可选的精确工具名
decision = allow | ask | deny
```

source 不匹配或 toolName 不匹配时继续下一条 rule。

pending Approval 默认有有限生命周期；当前 Core 默认 timeout 为 5 分钟。超时、调用取消、Control 重启时孤立的旧 pending request 都不会无限期保持成一个可执行授权。

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

Approval record 包含 `callId`、tool、source、input summary、risk level、Context/workspace（存在时）和最终 decision，并进入 instance audit。

## OAuth approval 不等于 Tool approval

OAuth registration/authorization 只决定某个 MCP client 是否获得 access token；拿到 token 后实际 tool call 仍要经过：

```text
tool group/capability
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

`disabled` 不代表“忽略所有安全检查”；工具自身的类型、路径、symlink、capability、auth 等检查仍然存在。

## Secret 扫描

`devshell secret` 由本机 Control 中的 builtin **Secret Extension** 提供，并且只接受 local-owner CLI 调用。CLI 只传扫描路径与选项；文件内容在 Control 主机本地读取，返回结果只包含 finding metadata，命中的 secret value 不会离开扫描器，也不会进入 MCP 或模型。

```bash
devshell secret scan [directory] [--glob <pattern>] [--limit <n>]
```

返回：

```json
{
  "findings": [
    { "type": "github_token", "path": "config/example.txt", "line": 12 }
  ],
  "truncated": false,
  "truncatedFiles": 0
}
```

每条 finding 只有：

```text
type
path
line
```

**永远不返回匹配值。**

当前检测类别包括：

```text
GitHub token 形态
AWS access key 形态
private key header
常见 token/secret/password/api_key 字符串赋值
```

generic assignment 会过滤常见 placeholder，降低示例配置的误报。

### Discovery

如果有 `rg`，优先使用 `rg --files --hidden` 并排除 `.git`；否则使用 self-contained 内置 walker，按分层 ignore scope 处理 `.gitignore` / `.ignore`（包括 negation），并跳过 `.git`、`.hg`、`.svn`、`node_modules`。

边界：

```text
默认 findings limit        200
最大 findings limit       1000
最多发现文件             20000
fallback traversal entry 50000
单文件最多读取             1 MiB
```

二进制（含 NUL）文件被跳过。超过 1 MiB 的文本只扫描开头并增加 `truncatedFiles`。

`--glob` 作用于已发现的相对路径，例如：

```bash
devshell secret scan . --glob '**/*.toml'
```

### Secret scan 的边界

这是轻量 preflight，不是凭据泄露的完整证明：

* pattern 可以漏报；
* generic pattern 可以误报；
* 不扫描超出 discovery/size 边界的全部内容；
* 不检查 Git 历史、远程 secret manager 或已删除文件。

因此适合提交/发布前快速检查，但不能替代专业 secret scanner 或仓库历史审计。

## Runtime Debug Patch

`devshell debug` 只允许本机 owner Control socket，并要求 Context scope。它能改变匹配调用的运行行为，因此虽然设计为可回滚保护模式，也只应被当作开发调试能力。

见 [运行时 Debug Patch](../tools/debug.md)。
