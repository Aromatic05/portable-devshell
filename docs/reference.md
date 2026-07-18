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

## 全局配置

```toml
version = 1

[control]
logLevel = "info"

[mcp]
enabled = false
listenHost = "127.0.0.1"
listenPort = 17890
publicBaseUrl = "http://127.0.0.1:17890"

[mcp.auth]
mode = "none"
```

认证模式：

```text
none
token
oauth2
```

`token` 模式必须配置至少 32 字节的随机密钥：

```toml
[mcp.auth]
mode = "token"
token = "replace-with-a-random-secret-of-at-least-32-bytes"
```

客户端必须发送完全匹配的 `Authorization: Bearer <token>`。配置文件会以当前用户可读写权限保存；不要把真实 token 提交到仓库。

公网建议只使用 `oauth2`。

## 本地实例配置

```toml
version = 2
name = "demo-local"
enabled = true
provider = "local"
workspace = "/absolute/path/to/workspace"

[mcp]
enabled = true
path = "/demo-local/mcp"

[mcp.tools]
groups = ["file", "bash", "artifact", "tmux", "todo"]
capabilities = ["read", "write", "execute"]

[security]
mode = "workspace"
```

常用字段：

- `version`：实例配置固定为 `2`；
- `name`：必须包含连字符；
- `provider`：`local`、`ssh`、`docker`、`podman`、`reverse`；
- `workspace`：worker 启动和工具运行的工作区；
- `[mcp].enabled`：是否注册 MCP endpoint；
- `[mcp].path`：可选，自定义 endpoint；
- `[mcp.tools].groups`：启用的工具组；
- `[mcp.tools].capabilities`：授予的 `read`、`write`、`execute`、`manage`；
- `[security].mode`：`disabled` 或 `workspace`。

实例配置只接受当前 schema；建议通过交互式创建或 TUI 生成后再按需编辑。

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
groups = ["file", "bash", "artifact", "tmux", "todo"]
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

## Worker 覆盖变量

```text
PORTABLE_DEVSHELL_WORKER_LINUX_X64_PATH
PORTABLE_DEVSHELL_WORKER_LINUX_ARM64_PATH
PORTABLE_DEVSHELL_WORKER_DARWIN_X64_PATH
PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH
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

安装时只准备 `linux-x64` 和当前主机 worker。Unix 的 `~/.devshell/bin/devshell-worker` 和 Windows 的 `%USERPROFILE%\.devshell\bin\devshell-worker.exe` 用于 control 主机上的默认执行；其他目标由 provider 探测后从对应 Release 按需下载、校验并传输。

## 进一步阅读

- [installation.md](installation.md)
- [architecture.md](architecture.md)
- [mcp.md](mcp.md)
- [oauth.md](oauth.md)
- [reverse-connections.md](reverse-connections.md)
