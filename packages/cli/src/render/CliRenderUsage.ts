export function renderCliUsage(): string {
    return [
        "portable-devshell",
        "",
        "Usage:",
        "  devshell [--verbose|--debug] <command>",
        "",
        "Commands:",
        "  status                         Show Control status (default)",
        "  start                          Start Control",
        "  restart                        Restart Control and restore running instances",
        "  stop                           Stop Control",
        "  logs                           Show Control logs",
        "  overview                       Show operational overview and alerts",
        "  config <command>               Read, validate, or update configuration",
        "  approval <command>             Review or decide tool approvals",
        "  oauth <command>                Inspect MCP OAuth and decide approvals",
        "  context <command>              Manage MCP contexts and messages",
        "  tui                            Open the terminal UI",
        "  instance <command>             Manage instances",
        "  watch <command>                Follow instance state or logs",
        "  artifact <command>             Manage artifact shares and transfers",
        "  help                           Show this help",
        "",
        "Run `devshell instance --help`, `devshell watch --help`, or `devshell artifact help` for details.",
    ].join("\n");
}

export function renderInstanceUsage(): string {
    return [
        "Usage:",
        "  devshell instance create",
        "  devshell instance delete <instance>",
        "  devshell instance enable <instance>",
        "  devshell instance disable <instance>",
        "  devshell instance list",
        "  devshell instance status <instance>",
        "  devshell instance start <instance>",
        "  devshell instance stop <instance>",
        "  devshell instance logs <instance> [-f]",
        "  devshell instance todo <instance> [--follow|-f]",
        "  devshell instance call <instance> <toolName> <jsonInput>",
        "  devshell instance device-code <instance>",
        "  devshell instance rotate-token <instance>",
        "  devshell instance revoke-token <instance>",
    ].join("\n");
}

export function renderWatchUsage(): string {
    return [
        "Usage:",
        "  devshell watch status <instance>",
        "  devshell watch logs <instance>",
    ].join("\n");
}
