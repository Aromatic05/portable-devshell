# 快速开始

这份流程从一个空的本地安装开始。安装方式见 [安装与升级](installation.md)。

## 1. 初始化

```bash
devshell init
```

对一个空安装，`devshell init` 会一次完成 first run：启动 Control、启用全局 MCP host、生成 OAuth2 approval token、创建默认 local instance `local-pc`，并在 instance enabled 时立即启动它。新建 instance 使用 OAuth2 与 `openai-session` Context mode；fresh Workspace feature switch 默认关闭。浏览器 OAuth 授权时使用 init 输出的 approval token 确认 registration / authorization，不要求打开 TUI；既有 `approval = "tui"` 配置仍走 TUI/CLI。

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
  '{"command":"pwd","waitMs":30000}'
```

这条路径不依赖 MCP；它适合先确认 instance 与 worker 本身正常。

## 4. 打开 TUI

```bash
devshell tui
```

TUI 可以查看实例、配置、审批、OAuth、审计、日志和 Workspace Goal。CLI 与 TUI 都通过同一个 Control RPC，不维护第二套运行状态。分步骤计划和工作记录保存在 Agent Memory 中。

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
path = "/local-pc/mcp"

[mcp.oauth2]
resourceName = "local-pc"
requiredScopes = ["mcp"]

[extensions]
model = ["artifact", "comment", "instance", "mcp", "recall", "secret", "skill"]

[workspace]
enabled = false
```

本机隔离测试仍可以显式使用 `auth = "none"`；公网 endpoint 应使用 HTTPS 和认证。裸 URL 保留 OpenAI 会话；Gemini Web / 通用客户端使用 `/local-pc/mcp/explicit`，agy 使用 `/local-pc/mcp/agy-session`。

## 6. MCP Agent 的第一步

MCP 侧不要把 instance 配置中的某个目录当成默认项目。绑定 Context 的入口从：

```text
environ_info(workspace=/absolute/path/on/worker)
```

开始。

它会建立 portable-devshell Context、prepare 当前 workspace，并在 Host 支持时一起 bootstrap Live Workspace。MCP `tools/list` 合并 Worker schema、Control runtime primitive 和 Extension `mcp.tools`，后者 contribution 变化会更新 catalog；instance group/capability 配置不裁剪目录，`[extensions].model` 单独控制 shell command。当前 endpoint 拒绝 legacy 协议请求，client 必须支持 2026-07-28。

`openai-session` 把内部 `ctxId` 隐藏在 model-facing schema 之外；`explicit` Context mode 则让通用 MCP client 显式携带它。详见 [Context](../concepts/context.md)。

使用 `/local-pc/mcp/stateless` 时跳过这一步，直接调用全部 8 个 Bash、File、Task、Terminal 基础工具；路径必须是 Worker 绝对路径，`bash_run` 及创建 terminal 时的 `cwd` 必填。该入口不提供 MCP App 或 Context 功能。

## 7. 验证长任务

所有命令均使用 `bash_run`；`waitMs` 控制本次调用等待时间，需要终端时设置 `pty: true`。例如：

```json
{
    "command": "cargo test",
    "waitMs": 180000
}
```

当前 MCP transport 使用 request-scoped SSE keepalive；普通 Context 的 `bash_run` 最多同步等待 180 秒。达到边界时任务继续运行，返回 task ID、cursor，并可转成 durable Wait 由 Workspace 继续跟踪。更短的 `waitMs` 可提前返回，使用 `task_input`（省略 `input` 轮询或传入交互输入）继续读取。

详见 [Process 与终端工具](../tools/process.md) 与 [Workspace](../concepts/workspace.md)。

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

旧 global version 1 与 instance version 2/3 只作为迁移输入兼容；新配置不要继续写旧结构，也不要在 instance 中写持久化 workspace path。已有 version 4 TOML 中的 `contextMode` 在读取时移除，保存后不再输出该字段。

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
