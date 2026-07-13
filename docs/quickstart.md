# 快速开始

这份文档假设你已经安装了 `devshell`。安装方式见 [installation.md](installation.md)。

## 1. 启动 control daemon

```bash
devshell start
devshell status
```

第一次启动会自动创建：

```text
~/.devshell/control/config.toml
~/.devshell/control/instances/
```

Linux 优先使用 `$XDG_RUNTIME_DIR/portable-devshell/control.sock`。当 `XDG_RUNTIME_DIR` 不存在时，会自动使用当前用户专属的临时目录；macOS 不需要额外设置环境变量。Windows 使用 `\\.\pipe\portable-devshell-control-<user>`。

## 2. 创建第一个 instance

运行交互式向导：

```bash
devshell instance create
```

第一次使用建议填写：

```text
name: demo-local
provider: local
workspace: 当前项目的绝对路径
MCP enabled: yes
```

实例名必须包含连字符。`demo` 无效，`demo-local` 有效。

向导默认启用这些 MCP group：

```text
file
bash
artifact
tmux
todo
```

默认 capability：

```text
read
write
execute
```

## 3. 启动 instance

```bash
devshell instance start demo-local
devshell instance status demo-local
```

看到 `ready: true` 表示 worker daemon、RPC 和工具 schema 已经就绪。

## 4. 验证工具调用

```bash
devshell instance call demo-local bash_run '{"command":"pwd"}'
```

查看实例日志：

```bash
devshell instance logs demo-local
```

持续跟踪日志：

```bash
devshell instance logs demo-local --follow
```

## 5. 打开 TUI

```bash
devshell tui
```

TUI 可以查看实例、编辑配置、处理工具审批和 OAuth 审批、检查审计记录、日志与 Todo。

## 6. 接入 MCP

默认全局配置中的 MCP 是关闭的。编辑：

```text
~/.devshell/control/config.toml
```

设置：

```toml
[mcp]
enabled = true
listenHost = "127.0.0.1"
listenPort = 17890
publicBaseUrl = "http://127.0.0.1:17890"

[mcp.auth]
mode = "none"
```

确认实例配置中已经启用 MCP：

```toml
[mcp]
enabled = true

[mcp.tools]
groups = ["file", "bash", "artifact", "tmux", "todo"]
capabilities = ["read", "write", "execute"]
```

重启 control：

```bash
devshell stop
devshell start
devshell instance start demo-local
```

endpoint 为：

```text
http://127.0.0.1:17890/demo-local/mcp
```

更完整的工具策略和验证方法见 [mcp.md](mcp.md)。

## 7. 停止

```bash
devshell instance stop demo-local
devshell stop
```

## 常见问题

### 找不到 `devshell`

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### instance 启动失败

先看：

```bash
devshell instance status demo-local
devshell instance logs demo-local
devshell logs
```

常见原因包括 workspace 不存在、SSH 命令不可用、容器未创建成功，或目标平台 worker 下载失败。

### 手写配置后启动失败

实例配置版本必须是 `2`，并使用 `[mcp.tools]` 配置工具组和能力。

下一步：

- 公网和 OAuth：[oauth.md](oauth.md)
- 客户端接入：[clients.md](clients.md)
- 路径与完整配置：[reference.md](reference.md)
