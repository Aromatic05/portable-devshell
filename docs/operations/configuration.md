# 配置与运行目录

这份文档记录当前 1.0 系列的持久配置、运行路径和运维入口。命令参数以当前 `devshell <command> --help` 为准；配置结构以 Control 的 normalize/validate 结果为准。

## 支持平台

```text
Linux x86-64
Linux arm64
macOS x86-64
macOS arm64
Windows x86-64
Windows arm64
```

主程序使用 Node.js 24 系列或更新版本；内置 Comment/Agent 使用的 Database capability 要求 **Node.js ≥24.12.0**（必须提供 SQLite authorizer 与 defensive API），不能使用任意早期 Node 24。Windows 提供完整 client 和 worker，`bash_run` 使用 PowerShell，持久化 tmux 工具使用 Worker 内嵌的 psmux；本地 Attach Shell 与 tmux 工具分别建模。

## 配置路径

```text
全局配置                 ~/.devshell/control/config.toml
实例配置目录             ~/.devshell/control/instances/
单个实例配置             ~/.devshell/control/instances/<instance>.toml
OAuth 持久化             ~/.devshell/control/oauth/
control 日志             ~/.devshell/control/logs/control.log
```

第一次执行 `devshell start` 会创建默认全局配置；新的本地安装优先使用 `devshell init` 完成 Control、首个 local instance、MCP OAuth2 与可选 Access 配置。

## 运行目录

优先使用：

```text
$XDG_RUNTIME_DIR/portable-devshell/control.sock
```

Windows control 使用当前用户专属 Named Pipe：

```text
\\.\pipe\portable-devshell-control-<user>
```

当 `XDG_RUNTIME_DIR` 未设置时，control 与客户端使用同一套用户专属临时目录解析规则：

```text
<TMPDIR>/portable-devshell-<uid>/control.sock
```

因此 macOS 不需要手动设置 `XDG_RUNTIME_DIR`。Windows 不使用 Unix socket；每个 worker instance 使用 `\\.\pipe\devshell-worker-<user>-<instance>`。

Worker 和 tmux/psmux 运行时按 instance 与 workspace 隔离；Unix 使用对应 socket，Windows 使用 Worker Named Pipe 和内嵌 psmux 后端。

## 初始化、迁移与升级

```text
devshell init
devshell migrate
devshell update [version]
```

`devshell init` 是 first run 产品入口；`devshell migrate` 显式执行仍受支持的 persistent schema migration；`devshell update` 默认更新到 latest，也可以指定 `x.y.z` release。升级与兼容性边界见 [Version 与 Compatibility Lifecycle](../development/compatibility.md)。

## Control 管理命令

CLI 的主要 Control 管理面包括：

```text
devshell overview
devshell config --help
devshell approval --help
devshell oauth --help
devshell context --help
devshell debug --help
devshell tool --help
devshell todo --help
devshell instance --help
devshell watch --help
devshell artifact --help
devshell secret --help
devshell skill --help
```

这些命令都通过 Control RPC 执行。各命令的完整参数以对应的 `--help` 输出为准。

配置修改优先使用 Control 自己的配置 API：

```text
devshell config get
devshell config validate <jsonDraft>
devshell config update <jsonUpdate>
devshell config instance patch <instance> <jsonPatch>
devshell config mcp patch <jsonPatch>
devshell config web patch <jsonPatch>
```

Control 会先 normalize、validate、preflight，再对支持的变更执行 runtime apply；返回结果会说明是否仍需要 Control restart。不要把“修改配置”固定等价成 `stop` + `start`。

## 全局配置

全局文件只配置 control、MCP listener 和 Web 管理界面。MCP 认证不在全局文件中配置，而是由每个 instance 独立决定。

```toml
version = 2

[control]
artifactDirectTransfer = false
logLevel = "info"

[mcp]
enabled = false
listenHost = "127.0.0.1"
listenPort = 17890
publicBaseUrl = "http://127.0.0.1:17890"

[web]
enabled = false
listenHost = "127.0.0.1"
listenPort = 17890
publicBaseUrl = "http://127.0.0.1:17890"
auth = "none"
```

Web 的默认 `listenHost` / `listenPort` 继承 MCP listener，因此两者默认都落在 `127.0.0.1:17890`。当 MCP 与 Web 同时启用且 endpoint 完全相同时，Control 复用同一个 HTTP host；只有显式把 Web 改到例如 `17891` 时才创建独立 listener。

`publicBaseUrl` 的 patch 语义区分“省略”和 `null`：

- MCP patch 省略该字段时保留现值；显式 `null` 会清除显式公网基址；
- Web patch 省略时保留现值；显式 `null` 会回到基于当前 `listenHost` / `listenPort` 推导的本地基址。

这对于临时撤掉反向代理/公网域名很重要，不需要为了“恢复默认”伪造一个 loopback URL 覆盖旧公网值。

Web 认证支持 `none`、`token` 和 `oauth2`。`token` 模式直接在 `[web]` 中配置至少 32 字节的随机 token：

```toml
[web]
enabled = true
listenHost = "127.0.0.1"
listenPort = 17891
publicBaseUrl = "https://devshell.example.com/web"
auth = "token"
token = "replace-with-a-random-secret-of-at-least-32-bytes"
```

Web OAuth 使用独立的 `[web.oauth2]`：

```toml
[web]
enabled = true
listenHost = "127.0.0.1"
listenPort = 17891
publicBaseUrl = "https://devshell.example.com/web"
auth = "oauth2"

[web.oauth2]
resourceName = "portable-devshell-web"
requiredScopes = ["web"]
documentationUrl = "https://devshell.example.com/docs"
```

## Instance MCP 认证

每个 instance 的 MCP endpoint 独立配置认证，因此同一个 listener 可以同时存在匿名、token 和 OAuth endpoint。

匿名 instance：

```toml
[mcp]
enabled = true
auth = "none"
path = "/demo-local/mcp"
```

Token instance：

```toml
[mcp]
enabled = true
auth = "token"
token = "replace-with-a-random-secret-of-at-least-32-bytes"
path = "/demo-token/mcp"
```

OAuth instance：

```toml
[mcp]
enabled = true
auth = "oauth2"
path = "/demo-oauth/mcp"

[mcp.oauth2]
resourceName = "demo-oauth"
requiredScopes = ["mcp"]
documentationUrl = "https://devshell.example.com/docs"
```

Token 以明文保存在权限为 `0600` 的用户配置文件中。配置视图和 TUI 会用 `********` 遮蔽已有 token；提交该占位符会保留原 token。

## 本地实例配置

```toml
version = 4
name = "demo-local"
enabled = true
provider = "local"

[mcp]
enabled = true
auth = "none"
contextMode = "openai-session"
path = "/demo-local/mcp"

[extensions]
model = ["artifact", "comment", "instance", "mcp", "recall", "secret", "skill"]

[workspace]
enabled = false

[security]
mode = "workspace"

[alerts]
intervalMs = 30000
maxUncommittedChanges = 100
workerMemoryBytes = 1073741824

[[alerts.scripts]]
id = "project-health"
command = ["project-health", "--json"]
timeoutMs = 5000
```

常用字段：

- `version`：全局配置当前为 `2`，实例配置当前为 `4`；
- `name`：必须包含连字符；
- `provider`：`local`、`ssh`、`docker`、`podman`、`reverse`；
- instance 配置不包含持久化默认 workspace path。worker 启动与实例生命周期不绑定项目目录；MCP Context 通过 `environ_info` 选择 primary instance 的绝对 workspace。其他 managed instance 由 model-facing `devshell instance list/status` 返回 Context-scoped opaque handle，再通过固定 MCP `environ_remote(command="attach", handle=..., workspace=...)` 附加；`mask` 会在当前 Context 中永久屏蔽该 remote instance，直到 Context 结束；
- `[workspace].enabled`：是否启用该 instance 的 Workspace App、Goal/Todo/Approval/Wait 交互与自动 re-entry。fresh instance 默认 `false`；旧 version 2/3 instance 迁移时为保持历史行为写成 `true`。设为 `false` 会 retire 已存在的 Workspace presentation/recovery state，但不会关闭 MCP endpoint、停止 Worker 或移除 bash/file/tmux runtime primitive；
- `[mcp].enabled`：是否注册该 instance 的 MCP endpoint；
- `[mcp].auth`：该 instance 独立使用 `none`、`token` 或 `oauth2`；
- `[mcp].contextMode`：选择 MCP 边界如何解析 portable-devshell Context。fresh instance 默认 `openai-session`，使用稳定 Host metadata 绑定内部 Context，并把 `ctxId` 留在模型 schema 之外；`explicit` 允许 model-facing 工具显式携带 `ctxId`。旧 version 2/3 instance 未显式配置该字段时迁移为 `explicit`，保持旧版本行为。两种模式内部都继续使用 `ctxId` 作为 runtime key；完整语义见 [Context](../concepts/context.md)；
- `[mcp].token`：仅在 `auth = "token"` 时使用，至少 32 UTF-8 字节；
- `[mcp].path`：固定为 `/<instance>/mcp`，不可自定义；
- `[extensions].model`：允许当前 instance 上的模型通过 `bash_run` / `tmux_run` 中 Context-bound `devshell` shim 调用的 Extension id allowlist（不是 command 名；例如 `comment` 授权它的 `memory`，`recall` 授权只读的 `recall`）。当前 bundled 默认是 `["artifact", "comment", "instance", "mcp", "recall", "secret", "skill"]`；独立安装的 Extension 需要显式加入；它不改变 MCP `tools/list`；
- `[security].mode`：`disabled` 或 `workspace`；
- `[alerts].intervalMs`：活跃 workspace 的后台 alert probe 周期，至少 `1000` ms；MCP Context 的有效工具调用会刷新该 workspace 的活跃租约，连续 24 小时无有效调用后停止 probe 并移除状态；
- `[alerts].maxUncommittedChanges`：Git 未提交条目数量阈值，必须为非负整数；
- `[alerts].workerMemoryBytes`：worker RSS 阈值，配置时必须为正整数；
- `[[alerts.scripts]]`：可选自定义 probe。`id` 与 `command` 必须非空，`timeoutMs` 必须为正整数。脚本工作目录为当前 workspace，并收到 `DEVSHELL_ALERT_WORKSPACE`；stdout 应输出由 `{code,text}` 对象组成的 JSON 数组。

当前 Broker 还识别精确匹配旧生成默认值的 `["artifact", "instance", "mcp", "secret", "skill"]` 与 `["artifact", "comment", "instance", "mcp", "secret", "skill"]`（含顺序）：两者额外允许 `recall` 命令，前者还允许 Comment 的 `memory` 命令。其他自定义 allowlist 不会因此自动扩展；存量配置文件无需改写。

Web auth 和 instance MCP auth 完全独立：修改 `[web]` 不会改变任何 instance endpoint；不同 instance 也可以使用不同认证模式和 token。

全局 version 1 配置仅作为旧格式迁移入口读取。旧 `[mcp.auth]` 会在迁移时下沉到 instance，写回后成为全局 version 2；旧 instance version 2/3 会迁移为 version 4，删除旧的持久化 workspace path，并丢弃已经退役的 `[mcp.tools]` group/capability policy。迁移同时保留旧缺省语义：`contextMode = "explicit"`、`[workspace].enabled = true`。version 4 fresh defaults 则分别是 `openai-session` 与 Workspace disabled；`[workspace]` 只接受 `enabled`，不是项目路径。

## Execution providers

Instance 的 `execution` 配置选择 Worker 执行环境与 sandbox；它与 instance transport `provider`、`security.mode` 分别建模。环境是数组，sandbox 只有一个对象：

```toml
[[execution.environment]]
order = 100
name = "variables"
content = { set = { PROJECT_MODE = "development" } }
phase = "process"
```

- `execution.environment[]`：每项必须有 `order`、`name`、`content`；`order` 是 1–999 的整数，在数组内唯一，normalize 后升序执行。
- `execution.sandbox`：单一 `{ name, content, phase? }`，没有 `order`；不支持 sandbox 数组或链式叠加。
- `name` 必须匹配 `^[a-z][a-z0-9-]*$`；`content` 是 provider-owned JSON，必须提供且不能是空字符串，具体结构由 provider 校验。
- 两者 `phase` 都可省略，Worker 默认 `process`；`daemon` 用于启动 Worker daemon 的环境/包装，`process` 用于工具子进程。daemon phase 不随每次工具 cwd 重新求值；Windows 当前拒绝需要 daemon-phase provider 的启动。

`variables` 环境和 `bubblewrap` sandbox 是 Core primitive；其他名字必须解析到 enabled Extension 的 `execution.environment` / `execution.sandbox` registration。Control 在 Worker start 时编译 driver snapshot，目标 Worker 执行求值，Control 不执行 provider 的环境脚本。环境 Extension 可在 manifest 中声明 `automatic: true`，启用后便自动参与工具进程环境准备，无需逐个 Instance 配置；显式环境项仍可覆盖同名自动项。随包 Direnv 即采用此方式：启用 Extension 后，Worker 对工具工作目录运行 `direnv export json`，无需在 Instance 的 `execution.environment` 中重复指定 Direnv。现有 Worker 的 driver snapshot 在下次启动时更新。

## SSH 实例

```toml
version = 4
name = "demo-ssh"
enabled = true
provider = "ssh"

[ssh]
command = "ssh user@example-host"

[mcp]
enabled = true

[extensions]
model = ["instance"]
```

worker 由 control 自动检测、上传并安装到远端用户目录。

## 容器实例

容器 provider 支持：

```text
发行版预设
Dockerfile
Compose
已有镜像
已有但已停止的容器
```

不把任意正在运行的容器作为首选创建模型。具体字段建议通过 `devshell instance create` 或 TUI 生成，避免手写复杂容器配置。

## 工具调度

实例可在 `[tools.scheduler]` 下配置全局和按 execution session 的并发、队列限制。当前实现支持排队，不再采用旧设计中的固定单并发无队列模型。这里的 scheduler session 不是 MCP protocol session，也不是 portable-devshell Context。

## 审计存储

每个实例的结构化 events、logs、tool calls 和 approvals 统一保存在：

```text
~/.devshell/<instance>/control-worker/audit.sqlite3
```

可以在实例配置中限制保留时间和存储容量：

```toml
[logs]
retentionDays = 7
maxBytes = 67108864
eventBufferSize = 100
```

`retentionDays` 默认 7 天，`maxBytes` 默认 64 MiB、最小 1 MiB。超过保留时间的记录会被删除；SQLite 数据库文件超过容量上限时，从最旧的审计记录开始淘汰并回收数据库页。`eventBufferSize` 只控制内存中的事件 replay 窗口，不控制 SQLite 持久化容量。小于 8 KiB 的 stdout/stderr 日志正文继续内联为 TEXT；更大的正文与 JSON 元数据分离存入 BLOB，高压缩收益内容使用 Zstd level 1，低收益内容使用 identity BLOB，读取接口会透明恢复原始 `message`。

模型提供的 tool-call `purpose` / `explanation` 属于 Control provenance，不下传 Worker。它使用独立的 hot/cold 生命周期：hot journal 位于 `~/.devshell/control/tool-call-provenance.jsonl`，默认达到 8 MiB 后压缩为 Zstd level 1 的 `tool-call-provenance.jsonl.archive/*.jsonl.zst`；cold 总量默认限制为 64 MiB，默认保留 7 天。运行时只常驻 hot provenance，查询历史 tool call 时通过 `instance + callId` 索引按需读取 cold archive。容量淘汰从最旧 cold archive 开始，不改变 Worker `audit.sqlite3` 的生命周期或权限边界。

升级时，旧的 `events.jsonl`、`logs.jsonl` 和 `tool-calls.jsonl` 会在首次打开实例时事务导入 SQLite，导入成功后删除旧文件。审批记录仅使用 SQLite 存储，旧的 `approvals.jsonl` 不再导入。

## 实例状态与数据

```text
实例事件与审计     ~/.devshell/<instance>/control-worker/audit.sqlite3
worker 配置与状态   ~/.devshell/<instance>/
tmux 元数据          ~/.devshell/<instance>/tmux/
worker 实体          ~/.devshell/workers/<target>/<sha256>/devshell-worker
各 target 软链       ~/.devshell/bin/devshell-worker-<target>
本机默认软链          ~/.devshell/bin/devshell-worker
```

## Extension 持久化目录

以下使用默认 Control home；`PORTABLE_DEVSHELL_HOME` 会改变 Control home 下的路径。Extension code/data 另按 data home 解析：优先 `$XDG_DATA_HOME`，Unix 缺省 `~/.local/share`，Windows 缺省 `%LOCALAPPDATA%`（缺省时 `%USERPROFILE%\AppData\Local`）。

```text
<data home>/portable-devshell/extensions/<id>/<generation>/    immutable code
<data home>/portable-devshell/extension-data/<id>/             persistent data / owned SQLite
~/.devshell/control/extensions/registry.json                  selected generation / enabled state
~/.devshell/control/extensions/state/<id>/config.json          Extension-owned config
<Control runtime dir>/extensions/<id>/<generation>/run-<UUID>/  one activation incarnation
```

普通 Extension remove 保留 data/state；`remove --purge` 删除它们。Runtime directory 每次 activation 独立，不应当作持久存储。Core config 的 scoped grant `config.coreAccess` 不会把 Core 值复制到 owned `config.json`；两者 authority 见[Extension ABI](../concepts/extensions.md)。

## Worker 目标

| portable-devshell target | Rust target                  |
| ------------------------ | ---------------------------- |
| `linux-x64`              | `x86_64-unknown-linux-musl`  |
| `linux-arm64`            | `aarch64-unknown-linux-musl` |
| `darwin-x64`             | `x86_64-apple-darwin`        |
| `darwin-arm64`           | `aarch64-apple-darwin`       |
| `windows-x64`            | `x86_64-pc-windows-msvc`     |
| `windows-arm64`          | `aarch64-pc-windows-msvc`    |

## Worker 覆盖变量

```text
PORTABLE_DEVSHELL_WORKER_LINUX_X64_PATH
PORTABLE_DEVSHELL_WORKER_LINUX_ARM64_PATH
PORTABLE_DEVSHELL_WORKER_DARWIN_X64_PATH
PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH
PORTABLE_DEVSHELL_WORKER_WINDOWS_X64_PATH
PORTABLE_DEVSHELL_WORKER_WINDOWS_ARM64_PATH
```

Release 下载相关变量：

```text
PORTABLE_DEVSHELL_WORKER_RELEASE_REPOSITORY
PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL
PORTABLE_DEVSHELL_WORKER_RELEASE_TAG
PORTABLE_DEVSHELL_WORKER_CACHE_DIR
```

安装相关变量：

```text
PORTABLE_DEVSHELL_INSTALL_ROOT
PORTABLE_DEVSHELL_BIN_DIR
PORTABLE_DEVSHELL_HOME
PORTABLE_DEVSHELL_VERSION
PORTABLE_DEVSHELL_RELEASE_REPOSITORY
PORTABLE_DEVSHELL_RELEASE_BASE_URL
```

安装时只准备当前主机 target 的 worker。Unix 的 `~/.devshell/bin/devshell-worker` 和 Windows 的 `%USERPROFILE%\.devshell\bin\devshell-worker.exe` 用于 control 主机上的默认执行；其他目标由 provider 探测后从对应 Release 按需下载、校验并传输。

## 进一步阅读

- [安装与升级](../getting-started/installation.md)
- [系统架构](../concepts/architecture.md)
- [MCP](../concepts/mcp.md)
- [Context](../concepts/context.md)
- [OAuth](oauth.md)
- [Reverse Worker](reverse-connections.md)
