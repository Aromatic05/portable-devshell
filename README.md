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
- packaged asset layout: `packages/core/assets/workers/<targetKey>/devshell-worker`
- install path:
  - local: `~/.devshell/workers/<targetKey>/<sha256>/devshell-worker`
  - ssh/container: `~/.devshell/workers/<targetKey>/<sha256>/devshell-worker`
  - active symlink: `~/.devshell/bin/devshell-worker`
- target-specific env override:
  - `PORTABLE_DEVSHELL_WORKER_LINUX_X64_PATH`
  - `PORTABLE_DEVSHELL_WORKER_LINUX_ARM64_PATH`
  - `PORTABLE_DEVSHELL_WORKER_DARWIN_X64_PATH`
  - `PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH`

代码已经支持 target-specific probe、asset resolution、install path 和 structured error。
仓库是否实际包含某个 target 的 worker binary，以 `packages/core/assets/workers/<targetKey>/` 下是否存在对应文件为准；若缺失，将返回 `core.workerAssetUnavailable`，而不是假装回退到错误平台的 binary。
在 Linux host 上，默认构建会直接尝试 musl target；如果当前机器没有对应 target/std/toolchain，构建会失败，而不是退回到动态链接的 `gnu` binary。
当前仓库快照已经包含 `linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64` 四个 target 的 worker asset。
