# Testspace

Only four commands are needed:

```bash
pnpm testspace
pnpm testspace tui
pnpm testspace web
pnpm testspace stop
```

- `pnpm testspace` builds and starts the isolated real Control, Worker, MCP endpoint and GPT-style connector.
- `pnpm testspace tui` enters the real TUI.
- `pnpm testspace web` opens the Web UI.
- `pnpm testspace stop` stops everything and deletes the entire `.testspace/` directory.

No normal `~/.devshell` configuration or workspace is modified. Generated tool calls are limited to harmless reads, short shell output, Todo updates and short tmux tasks inside `testspace-local`.
