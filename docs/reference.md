# 参考信息

这份文档收纳不适合放在首页的路径、布局和运行细节。

## 配置文件路径

- 全局配置: `~/.devshell/control/config.toml`
- 实例配置目录: `~/.devshell/control/instances/`
- 单个实例配置: `~/.devshell/control/instances/<instance>.toml`
- OAuth 持久化目录: `~/.devshell/control/oauth/`
- control runtime socket: `$XDG_RUNTIME_DIR/portable-devshell/control.sock`

`node packages/cli/dist/cli/CliMain.js start` 第一次启动时，如果全局配置不存在，会自动创建默认文件。

## 全局配置示例

```toml
version = 1

[control]
logLevel = "info"

[mcp]
enabled = true
listenHost = "127.0.0.1"
listenPort = 17890
publicBaseUrl = "http://127.0.0.1:17890"

[mcp.auth]
mode = "none"
```

支持的认证模式：

- `none`
- `token`
- `oauth2`

如果 `mode = "oauth2"`，还需要提供 `[mcp.auth.oauth2]`。

## 实例配置示例

```toml
version = 1
name = "demo"
enabled = true
provider = "local"
workspace = "/path/to/workspace"

[mcp]
enabled = true
allowTools = ["bash_run"]
```

常见字段：

- `provider`: `local`、`ssh`、`docker`、`podman`
- `workspace`: 工作区路径
- `[mcp].enabled`: 是否把这个实例暴露成 MCP endpoint
- `[mcp].allowTools`: 允许通过 MCP 暴露的工具名列表
- `[mcp].path`: 可选，自定义 endpoint path

## Endpoint 规则

- 默认是每实例一个 endpoint: `/<instance>/mcp`
- 如果实例配置了 `[mcp].path`，会改用自定义 path
- MCP host 只注册启用了 MCP 的实例
- MCP 只暴露工具调用入口，不暴露实例管理接口

## 运行时文件布局

常见运行时数据会出现在这些位置：

- control 日志: `~/.devshell/control/logs/control.log`
- instance 日志目录: `~/.devshell/<instance>/control-worker/`
- tool call 历史: `~/.devshell/<instance>/control-worker/tool-calls.jsonl`
- event 历史: `~/.devshell/<instance>/control-worker/events.jsonl`
- 结构化日志: `~/.devshell/<instance>/control-worker/logs.jsonl`

## Worker 目标与安装路径

当前支持的 worker target：

- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`

对应的 Rust target：

- `linux-x64` -> `x86_64-unknown-linux-musl`
- `linux-arm64` -> `aarch64-unknown-linux-musl`
- `darwin-x64` -> `x86_64-apple-darwin`
- `darwin-arm64` -> `aarch64-apple-darwin`

本地安装目录：

- worker 实体文件: `~/.devshell/workers/<target>/<sha256>/devshell-worker`
- 激活软链: `~/.devshell/bin/devshell-worker`

release 缓存目录：

- 默认: `~/.devshell/release-cache/workers/<tag>/<target>/<sha256>/devshell-worker`

## Worker 覆盖变量

如果你要强制指定某个平台的 worker，可用这些环境变量：

- `PORTABLE_DEVSHELL_WORKER_LINUX_X64_PATH`
- `PORTABLE_DEVSHELL_WORKER_LINUX_ARM64_PATH`
- `PORTABLE_DEVSHELL_WORKER_DARWIN_X64_PATH`
- `PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH`

控制 release 下载行为的环境变量：

- `PORTABLE_DEVSHELL_WORKER_RELEASE_REPOSITORY`
- `PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL`
- `PORTABLE_DEVSHELL_WORKER_RELEASE_TAG`
- `PORTABLE_DEVSHELL_WORKER_CACHE_DIR`

默认 release repository 是：

```text
Aromatic05/portable-devshell
```

## 进一步阅读

- 用户上手: [quickstart.md](quickstart.md)
- MCP 暴露: [mcp.md](mcp.md)
- OAuth: [oauth.md](oauth.md)
- 客户端接入: [clients.md](clients.md)
- 内部设计: [portable-devshell-ts-design.md](portable-devshell-ts-design.md)
