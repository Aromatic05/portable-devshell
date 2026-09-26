# 快速开始

这份流程从一个空的本地安装开始。安装方式见 [安装与升级](installation.md)。

## 1. 初始化

```bash
devshell init
```

对一个空安装，`devshell init` 会一次完成 first run：启动 Control、启用全局 MCP host、生成 OAuth2 approval token、创建默认 local instance `local-pc`，并在 instance enabled 时立即启动它。新建 instance 使用 OAuth2 与 `openai-session` Context mode；fresh Workspace feature switch 默认关闭。

交互终端中，如果 Access Extension 可用，`init` 还会询问公网接入方式：已经有公网入口、Cloudflare Tunnel、SSH reverse，或稍后配置。Access Extension 被移除或不可用时会直接跳过这一步，不把可选插件变成 first run 的失败条件。

完成后检查：

```bash
devshell status
devshell instance status local-pc
```

如果已经存在 local instance，`init` 会复用它而不是强制创建 `local-pc`。需要完全手工分步配置时，仍可以使用 `devshell start` 和 `devshell instance create`。

第一次初始化会创建：

```text
~/.devshell/control/config.toml
~/.devshell/control/instances/
```

Control IPC 默认只对当前用户开放：

```text
Linux/macOS  $XDG_RUNTIME_DIR/portable-devshell/control.sock
Windows      \\.\pipe\portable-devshell-control-<user>
```

Unix 没有 `XDG_RUNTIME_DIR` 时会使用当前用户专属的临时目录；macOS 不需要为了 portable-devshell 手工设置它。

## 2. 检查 instance

```bash
devshell instance status local-pc
```

`ready: true` 表示 worker daemon、RPC 与当前工具 schema 已经就绪。

查看日志：

```bash
devshell instance logs local-pc
```

持续跟踪：

```bash
devshell instance logs local-pc -f
```

## 3. 验证 worker 调用

CLI 直接调用必须显式给出 worker 上的绝对 workspace：

```bash
devshell instance call \
  local-pc \
  /absolute/path/to/project \
  bash_run \
  '{"command":"pwd","timeoutMs":30000}'
```

这条路径不依赖 MCP；它适合先确认 instance 与 worker 本身正常。

## 4. 打开 TUI

```bash
devshell tui
```

TUI 可以查看实例、配置、审批、OAuth、审计、日志和 Todo。CLI 与 TUI 都通过同一个 Control RPC，不维护第二套运行状态。

## 5. MCP HTTP host

fresh `devshell init` 已经启用全局 MCP host。现有安装如果仍然关闭，可以通过 Control 配置 API 启用，而不是手工编辑后无条件重启：

```bash
devshell config mcp patch '{
  "enabled": true,
  "listenHost": "127.0.0.1",
  "listenPort": 17890,
  "publicBaseUrl": "http://127.0.0.1:17890"
}'
```

确认：

```bash
devshell config get
devshell instance status local-pc
```

fresh `devshell init` 的默认 endpoint 是：

```text
http://127.0.0.1:17890/local-pc/mcp
```

当前 instance 配置写回格式是 version `4`。fresh init 创建的主要 MCP / Extension / Workspace 字段类似：

```toml
[mcp]
enabled = true
auth = "oauth2"
contextMode = "openai-session"
path = "/local-pc/mcp"

[mcp.oauth2]
resourceName = "local-pc"
requiredScopes = ["mcp"]

[extensions]
model = ["artifact", "instance", "mcp", "secret", "skill"]

[workspace]
enabled = false
```

本机隔离测试仍可以显式使用 `auth = "none"`；公网 endpoint 应使用 HTTPS 和认证。`openai-session` 是 fresh default；如果 Host 不提供稳定 session binding、需要模型显式携带 `ctxId`，应把该 instance 改为 `contextMode = "explicit"`。

## 6. MCP Agent 的第一步

MCP 侧不要把 instance 配置中的某个目录当成默认项目。正常工作流从：

```text
environ_info(workspace=/absolute/path/on/worker)
```

开始。

它会建立 portable-devshell Context、prepare 当前 workspace，并在 Host 支持时一起 bootstrap Live Workspace。MCP `tools/list` 不再由 instance group/capability 配置动态裁剪。

`openai-session` 把内部 `ctxId` 隐藏在 model-facing schema 之外；`explicit` Context mode 则让通用 MCP client 显式携带它。详见 [Context](../concepts/context.md)。

## 7. 验证长任务

需要长时间运行或 PTY 的命令使用 `tmux_run`。例如：

```json
{
    "command": "cargo test",
    "wait": "block",
    "timeout": 600000
}
```

当前 MCP transport 使用 request-scoped SSE keepalive；`wait=block` 最多保持同一个 tool call 同步阻塞 180 秒。任务超过 180 秒不会被杀掉，而是转成 durable Wait，由 Workspace 继续跟踪。

详见 [tmux 工具](../tools/tmux.md) 与 [Workspace](../concepts/workspace.md)。

## 8. 停止

```bash
devshell instance stop local-pc
devshell stop
```

Reverse instance 是 self-managed worker，生命周期与普通 local/ssh/container instance 不同；见 [Reverse Worker](../operations/reverse-connections.md)。

## 常见问题

### 找不到 `devshell`

```bash
export PATH="$HOME/.local/bin:$PATH"
```

安装器默认把入口放在 `~/.local/bin`。

### instance 启动失败

依次查看：

```bash
devshell instance status local-pc
devshell instance logs local-pc
devshell logs
```

常见原因是 provider 本身不可用、SSH 命令失败、容器创建失败或目标平台 worker 获取失败。workspace 不属于 instance 启动配置，因此“项目目录不存在”通常应在实际工具调用或 `environ_info` 阶段诊断。

### 手写配置后失败

当前写回版本：

```text
global config   2
instance config 4
```

旧 global version 1 与 instance version 2/3 只作为迁移输入兼容；新配置不要继续写旧结构，也不要在 instance 中写持久化 workspace path。旧 instance 缺省的 `contextMode` / Workspace enablement 会按旧行为迁移为 `explicit` / enabled，不会被 fresh defaults 改写。

优先使用：

```bash
devshell config validate '<json-draft>'
devshell config update '<json-update>'
devshell config instance patch local-pc '<json-patch>'
```

## 下一步

- [MCP](../concepts/mcp.md)
- [Context](../concepts/context.md)
- [Workspace](../concepts/workspace.md)
- [OAuth 与公网暴露](../operations/oauth.md)
- [客户端接入](clients.md)
- [配置与运行目录](../operations/configuration.md)
