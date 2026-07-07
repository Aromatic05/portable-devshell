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
