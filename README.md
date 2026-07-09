# portable-devshell 0.2

`portable-devshell` 现在以 TypeScript controller daemon 为中心：

- CLI / TUI / MCP stdio / public REST / public MCP 都连接 controller
- controller 负责配置、device registry、audit、policy、worker lifecycle、public auth
- Rust worker 只负责 bash / file / tmux 一类执行能力

主配置路径：

- `~/.devshell/control/config.toml`
- `~/.devshell/control/instances/*.toml`

最小配置可以只有：

```toml
version = 1
```

开启带 OAuth 的 public MCP / ChatGPT Connector：

```toml
version = 1

[control]
logLevel = "info"

[mcp]
enabled = true
listenHost = "0.0.0.0"
listenPort = 17890
publicBaseUrl = "https://devshell.example.com"

[mcp.auth]
mode = "oauth2"

[mcp.auth.oauth2]
issuer = "https://auth.example.com/realms/aromatic"
audience = "aromatic-mcp"
resourceName = "aromatic"
requiredScopes = ["mcp"]
documentationUrl = "https://docs.example.com/aromatic"
```

实例配置示例：

```toml
version = 1
name = "aromatic-pc"
enabled = true
provider = "local"
workspace = "/workspace/aromatic"

[mcp]
enabled = true
allowTools = ["bash_run"]
```

常用命令：

- `devshell start`
- `devshell instance start aromatic-pc`
- `devshell instance status aromatic-pc`
- `devshell tui`

ChatGPT Connector 使用入口：

- MCP endpoint: `https://devshell.example.com/aromatic-pc/mcp`
- protected resource metadata: `https://devshell.example.com/.well-known/oauth-protected-resource/aromatic-pc/mcp`
- authorization server metadata mirror: `https://devshell.example.com/.well-known/oauth-authorization-server`

当前实现定位：

- `portable-devshell` 自身作为 MCP protected resource。
- OAuth / OIDC 由外部成熟身份提供商负责。
- MCP server 负责 discovery、Bearer challenge、JWT/JWKS 校验和 metadata 暴露。

## Worker Targets

`portable-devshell` 的 TypeScript core 现在按 worker target 解析和安装 `devshell-worker`。

- supported targets: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`
- linux build targets: `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl` (static linking)
- local target probe: `process.platform` + `process.arch`
- ssh target probe: remote `uname -s` + `uname -m`
- docker/podman target probe: container `uname -s` + `uname -m`
- release asset layout: `devshell-worker-<targetKey>` and `devshell-worker-<targetKey>.sha256`
- install path:
  - local: `~/.devshell/workers/<targetKey>/<sha256>/devshell-worker`
  - ssh/container: `~/.devshell/workers/<targetKey>/<sha256>/devshell-worker`
  - active symlink: `~/.devshell/bin/devshell-worker`
- release cache path: `~/.devshell/release-cache/workers/<tag>/<targetKey>/<sha256>/devshell-worker`
- target-specific env override:
  - `PORTABLE_DEVSHELL_WORKER_LINUX_X64_PATH`
  - `PORTABLE_DEVSHELL_WORKER_LINUX_ARM64_PATH`
  - `PORTABLE_DEVSHELL_WORKER_DARWIN_X64_PATH`
  - `PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH`
- release lookup config:
  - default repository: `Aromatic05/portable-devshell`
  - optional override: `PORTABLE_DEVSHELL_WORKER_RELEASE_REPOSITORY=owner/repo`
  - optional: `PORTABLE_DEVSHELL_WORKER_RELEASE_TAG=v0.2.0`
  - optional: `PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL=https://github.com/owner/repo/releases/download`
  - optional: `PORTABLE_DEVSHELL_WORKER_CACHE_DIR=/custom/cache/path`

- local build scripts:
  - `pnpm build` only builds TypeScript packages
  - `pnpm build:worker:debug` builds the host debug worker
  - `pnpm build:worker:debug:<targetKey>` builds a specific debug worker target

代码已经支持 target-specific probe、release asset resolution、install path 和 structured error。
默认发布流程会在 GitHub tag `v*` 上自动构建四个 target 的 worker，并把二进制和对应 `.sha256` 上传到同名 GitHub Release。
运行时如果没有 target-specific 本地覆盖路径，core 会先探测目标平台，再按 release tag 下载对应 worker；若 release 不存在或校验失败，将返回 `core.workerAssetUnavailable`。
在 Linux host 上，默认构建会直接尝试 musl target；如果当前机器没有对应 target/std/toolchain，构建会失败，而不是退回到动态链接的 `gnu` binary。
