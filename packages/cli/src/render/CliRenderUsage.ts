export type CliHelpTopic = "approval" | "config" | "context" | "oauth" | "todo" | "tool";

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
        "  tool <command>                 Inspect tool calls",
        "  todo <command>                 Manage Todo projects",
        "  tui                            Open the terminal UI",
        "  instance <command>             Manage instances",
        "  watch <command>                Follow instance state or logs",
        "  artifact <command>             Manage artifact shares and transfers",
        "  help                           Show this help",
        "",
        "Run `devshell <command> --help` for command-specific usage.",
    ].join("\n");
}

export function renderCliTopicUsage(topic: CliHelpTopic): string {
    switch (topic) {
        case "config":
            return [
                "Usage:",
                "  devshell config get",
                "  devshell config validate <jsonDraft>",
                "  devshell config update <jsonUpdate>",
                "  devshell config instance patch <instance> <jsonPatch>",
                "  devshell config mcp patch <jsonPatch>",
                "  devshell config web patch <jsonPatch>",
            ].join("\n");
        case "approval":
            return [
                "Usage:",
                "  devshell approval list <instance>",
                "  devshell approval show <instance> <approvalId>",
                "  devshell approval approve <instance> <approvalId> [--reason <text>] [--remember] [--policy-patch <json>]",
                "  devshell approval deny <instance> <approvalId> [--reason <text>] [--remember] [--policy-patch <json>]",
            ].join("\n");
        case "oauth":
            return [
                "Usage:",
                "  devshell oauth status",
                "  devshell oauth list",
                "  devshell oauth approve <approvalId>",
                "  devshell oauth deny <approvalId>",
            ].join("\n");
        case "context":
            return [
                "Usage:",
                "  devshell context list",
                "  devshell context messages <instance> [ctxId]",
                "  devshell context send <instance> <ctxId> <text>",
                "  devshell context disable <ctxId>",
                "  devshell context renew <ctxId>",
            ].join("\n");
        case "tool":
            return [
                "Usage:",
                "  devshell tool calls <instance> [callId]",
            ].join("\n");
        case "todo":
            return [
                "Usage:",
                "  devshell todo delete <instance> <taskId>",
            ].join("\n");
    }
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
        "  devshell instance call <instance> <workspace> <toolName> <jsonInput>",
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
