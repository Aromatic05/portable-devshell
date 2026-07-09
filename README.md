# portable-devshell 0.2

`portable-devshell` 现在以 TypeScript controller daemon 为中心：

- CLI / TUI / MCP stdio / public REST / public MCP 都连接 controller
- controller 负责配置、device registry、audit、policy、worker lifecycle、public auth
- Rust worker 只负责 bash / file / tmux 一类执行能力

主配置路径：

- `~/.devshell/config/devshell.toml`

最小配置可以只有：

```toml
version = 1
```

开启 public Connector 的最小配置：

```toml
version = 1

[public]
enabled = true
publicBaseUrl = "https://devshell.example.com"

[public.oauth]
enabled = true
```

常用命令：

- `devshell config print --expanded`
- `devshell public urls`
- `devshell public doctor`
- `devshell mcp serve`
- `devshell tui`

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
  - `PORTABLE_DEVSHELL_WORKER_RELEASE_REPOSITORY=owner/repo`
  - optional: `PORTABLE_DEVSHELL_WORKER_RELEASE_TAG=v0.2.0`
  - optional: `PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL=https://github.com/owner/repo/releases/download`
  - optional: `PORTABLE_DEVSHELL_WORKER_CACHE_DIR=/custom/cache/path`

代码已经支持 target-specific probe、release asset resolution、install path 和 structured error。
默认发布流程会在 GitHub tag `v*` 上自动构建四个 target 的 worker，并把二进制和对应 `.sha256` 上传到同名 GitHub Release。
运行时如果没有 target-specific 本地覆盖路径，core 会先探测目标平台，再按 release tag 下载对应 worker；若 release 不存在或校验失败，将返回 `core.workerAssetUnavailable`。
在 Linux host 上，默认构建会直接尝试 musl target；如果当前机器没有对应 target/std/toolchain，构建会失败，而不是退回到动态链接的 `gnu` binary。
