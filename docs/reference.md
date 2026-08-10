# 参考信息

## 支持平台

```text
Linux x86-64
Linux arm64
macOS x86-64
macOS arm64
Windows x86-64
Windows arm64
```

主程序需要 Node.js 24 或更高版本。Windows 提供完整 client 和基础能力 worker；Windows worker 使用 PowerShell，不提供 tmux 或本地 Attach Shell。

## 配置路径

```text
全局配置                 ~/.devshell/control/config.toml
实例配置目录             ~/.devshell/control/instances/
单个实例配置             ~/.devshell/control/instances/<instance>.toml
OAuth 持久化             ~/.devshell/control/oauth/
control 日志             ~/.devshell/control/logs/control.log
```

第一次执行 `devshell start` 会创建默认全局配置。

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

worker 和 tmux 在 Unix 上仍维护各 instance 的独立运行目录与 socket；Windows worker 不注册 tmux 工具。

## Control 管理命令

除 `instance`、`watch` 和 `artifact` 外，CLI 还直接提供 Control 管理面：

```text
devshell overview
devshell config --help
devshell approval --help
devshell oauth --help
devshell context --help
devshell tool --help
devshell todo --help
```

这些命令都通过 Control RPC 执行。各命令的完整参数以对应的 `--help` 输出为准。

## 全局配置

全局文件只配置 control、MCP listener 和 Web 管理界面。MCP 认证不在全局文件中配置，而是由每个 instance 独立决定。

```toml
version = 2

[control]
logLevel = "info"

[mcp]
enabled = false
listenHost = "127.0.0.1"
listenPort = 17890
publicBaseUrl = "http://127.0.0.1:17890"

[web]
enabled = false
listenHost = "127.0.0.1"
listenPort = 17891
publicBaseUrl = "http://127.0.0.1:17891/web"
auth = "none"
```

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
version = 2
name = "demo-local"
enabled = true
provider = "local"
workspace = "/absolute/path/to/workspace"

[mcp]
enabled = true
auth = "none"
path = "/demo-local/mcp"

[mcp.tools]
groups = ["file", "bash", "artifact", "tmux", "todo", "context"]
capabilities = ["read", "write", "execute"]

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

- `version`：全局和实例配置当前均为 `2`；
- `name`：必须包含连字符；
- `provider`：`local`、`ssh`、`docker`、`podman`、`reverse`；
- `workspace`：instance 的默认 workspace；worker 启动以及未另外指定 workspace 的调用使用该值。MCP Context 通过 `environ_info` 可以在同一 worker 上选择调用方已获准访问的其他绝对目录；
- `[mcp].enabled`：是否注册该 instance 的 MCP endpoint；
- `[mcp].auth`：该 instance 独立使用 `none`、`token` 或 `oauth2`；
- `[mcp].token`：仅在 `auth = "token"` 时使用，至少 32 UTF-8 字节；
- `[mcp].path`：固定为 `/<instance>/mcp`，不可自定义；
- `[mcp.tools].groups`：启用的工具组；
- `[mcp.tools].capabilities`：授予的 `read`、`write`、`execute`、`manage`；
- `[security].mode`：`disabled` 或 `workspace`；
- `[alerts].intervalMs`：活跃 workspace 的后台 alert probe 周期，至少 `1000` ms；MCP Context 的有效工具调用会刷新该 workspace 的活跃租约，连续 24 小时无有效调用后停止 probe 并移除状态；
- `[alerts].maxUncommittedChanges`：Git 未提交条目数量阈值，必须为非负整数；
- `[alerts].workerMemoryBytes`：worker RSS 阈值，配置时必须为正整数；
- `[[alerts.scripts]]`：可选自定义 probe。`id` 与 `command` 必须非空，`timeoutMs` 必须为正整数。脚本工作目录为当前 workspace，并收到 `DEVSHELL_ALERT_WORKSPACE`；stdout 应输出由 `{code,text}` 对象组成的 JSON 数组。

Web auth 和 instance MCP auth 完全独立：修改 `[web]` 不会改变任何 instance endpoint；不同 instance 也可以使用不同认证模式和 token。

全局 version 1 配置仅作为旧格式迁移入口读取。旧 `[mcp.auth]` 会在迁移时下沉到 instance，写回后统一成为 version 2；新配置不要继续使用旧结构。

## SSH 实例

```toml
version = 2
name = "demo-ssh"
enabled = true
provider = "ssh"
workspace = "/srv/project"

[ssh]
command = "ssh user@example-host"

[mcp]
enabled = true

[mcp.tools]
groups = ["file", "bash", "artifact", "tmux", "todo", "context"]
capabilities = ["read", "write", "execute"]
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

实例可在 `[tools.scheduler]` 下配置全局和按 session 的并发、队列限制。当前实现支持排队，不再采用旧设计中的固定单并发无队列模型。

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

`retentionDays` 默认 7 天，`maxBytes` 默认 64 MiB、最小 1 MiB。超过保留时间的记录会被删除；SQLite 数据库文件超过容量上限时，从最旧的审计记录开始淘汰并回收数据库页。`eventBufferSize` 只控制内存中的事件 replay 窗口，不控制 SQLite 持久化容量。

升级时，旧的 `events.jsonl`、`logs.jsonl`、`tool-calls.jsonl` 和 `approvals.jsonl` 会在首次打开实例时事务导入 SQLite，导入成功后删除旧文件。

## 实例状态与数据

```text
实例事件与审计     ~/.devshell/<instance>/control-worker/audit.sqlite3
worker 配置与状态   ~/.devshell/<instance>/
tmux 元数据          ~/.devshell/<instance>/tmux/
worker 实体          ~/.devshell/workers/<target>/<sha256>/devshell-worker
各 target 软链       ~/.devshell/bin/devshell-worker-<target>
本机默认软链          ~/.devshell/bin/devshell-worker
```

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

- [installation.md](installation.md)
- [architecture.md](architecture.md)
- [mcp.md](mcp.md)
- [oauth.md](oauth.md)
- [reverse-connections.md](reverse-connections.md)
