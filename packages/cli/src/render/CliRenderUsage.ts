import type { CliCommandDescriptor } from "@portable-devshell/shared";

export type CliHelpTopic = "approval" | "config" | "context" | "debug" | "oauth" | "todo" | "tool";

export function renderCliUsage(): string {
    return [
        "portable-devshell",
        "",
        "Usage:",
        "  devshell [--verbose|--debug] <command>",
        "  devshell --version",
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
        "  debug <command>                Apply protected local runtime debug patches",
        "  tool <command>                 Inspect tool calls",
        "  todo <command>                 Manage Todo projects",
        "  tui                            Open the terminal UI",
        "  instance <command>             Manage instances",
        "  watch <command>                Follow instance state or logs",
        "  artifact <command>             Manage artifact shares and transfers",
        "  secret <command>               Scan local files for likely secrets",
        "  skill <command>                Discover, manage, and transfer layered Agent Skills",
        "  extension <command>            Manage installed Extensions",
        "  <extension-id> [args...]        Invoke an installed Extension command",
        "  help                           Show this help",
        "",
        "Run `devshell <command> --help` for related usage.",
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
        case "debug":
            return [
                "Usage:",
                "  devshell debug targets",
                "  devshell debug list",
                "  devshell debug load <target> <file> --ctx <ctxId> [--tool <toolName>]",
                "  devshell debug release <patchId>",
                "  devshell debug unload <patchId>",
                "",
                "Debug patch operations are accepted only through the local owner Control socket.",
            ].join("\n");
        case "tool":
            return [
                "Usage:",
                "  devshell tool calls <instance> [callId]",
                "  devshell tool calls <instance> [--limit <n>] [--before <callId>] [--after <callId>]",
            ].join("\n");
        case "todo":
            return [
                "Usage:",
                "  devshell todo delete <instance> <taskId>",
            ].join("\n");
    }
}

export function renderExtensionUsage(): string {
    return [
        "Usage:",
        "  devshell extension install <bundle-or-directory>",
        "  devshell extension remove <extensionId> [--purge]",
        "  devshell extension list",
        "  devshell extension inspect <extensionId>",
        "  devshell extension enable <extensionId>",
        "  devshell extension disable <extensionId>",
        "  devshell extension reload <extensionId>",
        "",
        "Installed Extension commands use `devshell <extension-id> [args...]`."
    ].join("\n");
}

export function renderExtensionCommandUsage(command: CliCommandDescriptor): string {
    return [
        command.title,
        "",
        "Usage:",
        `  devshell ${command.usage ?? command.id}`,
        ...(command.summary === undefined ? [] : ["", command.summary]),
        "",
        `Extension: ${command.extensionId}`,
    ].join("\n");
}

export function renderWatchUsage(): string {
    return [
        "Usage:",
        "  devshell watch status <instance>",
        "  devshell watch logs <instance>",
    ].join("\n");
}
