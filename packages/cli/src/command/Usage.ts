import type { CliCommandDescriptor } from "@portable-devshell/shared";

export type CliHelpTopic =
    "approval" | "config" | "context" | "debug" | "oauth" | "todo" | "tool";

export function renderCliUsage(
    commands: readonly CliCommandDescriptor[] = [],
): string {
    const lines = [
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
    ];
    if (commands.length > 0) {
        lines.push("", "Installed commands:");
        for (const command of commands) {
            lines.push(
                `  ${command.id.padEnd(30)} ${command.summary ?? command.title}`,
            );
        }
    }
    return lines.join("\n");
}

export function renderCliTopicUsage(
    topic: CliHelpTopic,
    command?: string,
): string {
    const usage = (() => {
        switch (topic) {
            case "config":
                return [
                    "Usage:",
                    "  devshell config get",
                    "  devshell config validate <jsonDraft|@file|->",
                    "  devshell config update <jsonUpdate|@file|->",
                    "  devshell config instance patch <instance> <jsonPatch|@file|->",
                    "  devshell config mcp patch <jsonPatch|@file|->",
                    "  devshell config web patch <jsonPatch|@file|->",
                ].join("\n");
            case "approval":
                return [
                    "Usage:",
                    "  devshell approval list <instance>",
                    "  devshell approval show <instance> <approvalId>",
                    "  devshell approval approve <instance> <approvalId> [--reason <text>] [--remember] [--policy-patch <json|@file|->]",
                    "  devshell approval deny <instance> <approvalId> [--reason <text>] [--remember] [--policy-patch <json|@file|->]",
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
    })();
    return command === undefined
        ? usage
        : leafUsage(usage, `devshell ${topic} ${command}`);
}

export function renderInstanceUsage(command?: string): string {
    const usage = [
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
        "  devshell instance call <instance> <workspace> <toolName> <json|@file|->",
        "  devshell instance device-code <instance>",
        "  devshell instance rotate-token <instance>",
        "  devshell instance revoke-token <instance>",
    ].join("\n");
    return command === undefined
        ? usage
        : leafUsage(usage, `devshell instance ${command}`);
}

export function renderWatchUsage(command?: string): string {
    const usage = [
        "Usage:",
        "  devshell watch status <instance>",
        "  devshell watch logs <instance>",
    ].join("\n");
    return command === undefined
        ? usage
        : leafUsage(usage, `devshell watch ${command}`);
}

function leafUsage(usage: string, prefix: string): string {
    const matches = usage
        .split("\n")
        .filter((line) => line.trimStart().startsWith(prefix));
    return matches.length === 0 ? usage : ["Usage:", ...matches].join("\n");
}
