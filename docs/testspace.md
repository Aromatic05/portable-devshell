# Testspace

Only four commands are needed:

```bash
pnpm testspace
pnpm testspace tui
pnpm testspace web
pnpm testspace stop
```

- `pnpm testspace` builds and starts the isolated real Control, local and reverse Workers, both MCP endpoints and GPT-style activity connectors.
- `pnpm testspace tui` enters the real TUI.
- `pnpm testspace web` opens the Web UI.
- `pnpm testspace stop` stops everything and deletes the entire `.testspace/` directory.

Testspace is an interactive observation space rather than a substitute for automated acceptance. The `status` and smoke commands are diagnostic probes; the main workflow is to enter the real TUI/Web and inspect both `testspace-local` and `testspace-reverse` while their connectors generate activity.

`DEVSHELL_TESTSPACE_ROOT` may point to a new directory or a directory already owned by Testspace. An existing custom directory without the Testspace ownership marker is rejected before state, PID or cleanup operations are attempted.

No normal `~/.devshell` configuration or workspace is modified. Generated tool calls are limited to harmless reads, short shell output, Todo updates and short tmux tasks inside the isolated Testspace workspaces.
