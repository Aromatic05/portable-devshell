import { CliRenderError } from "../../app/Failure.js";
import type { CliParsedCommand } from "../Parse.js";
import { renderCliTopicUsage } from "../Usage.js";

export function parseOAuthCommand(argv: readonly string[]): CliParsedCommand {
    switch (argv[0]) {
        case "help":
        case "--help":
        case "-h":
            return expectNoExtra(argv, { kind: "help", topic: "oauth" });
        case "status":
            return expectNoExtra(argv, { kind: "oauth.status" });
        case "list":
            return expectNoExtra(argv, { kind: "oauth.list" });
        case "approve":
        case "deny":
            if (argv.length !== 2)
                throw CliRenderError.usage(
                    `oauth ${argv[0]} requires <approvalId>`,
                );
            return {
                approvalId: required(argv[1], "approvalId is required"),
                decision: argv[0],
                kind: "oauth.decide",
            };
        default:
            throw CliRenderError.usage(
                `${`Unknown oauth command: ${argv[0] ?? ""}`.trim()}\n\n${renderCliTopicUsage("oauth")}`,
            );
    }
}
function required(value: string | undefined, message: string): string {
    if (value) return value;
    throw CliRenderError.usage(message);
}
function expectNoExtra<T extends CliParsedCommand>(
    argv: readonly string[],
    value: T,
): T {
    if (argv.length !== 1)
        throw CliRenderError.usage(`Unexpected arguments for ${argv[0]}`);
    return value;
}

import type { CliDispatchContext } from "../Dispatch.js";
export async function executeOAuthCommand(
    command: CliParsedCommand,
    context: CliDispatchContext,
): Promise<boolean> {
    switch (command.kind) {
        case "oauth.status":
            context.writeJson(await context.clients.mcp.status());
            return true;
        case "oauth.list":
            context.writeJson(await context.clients.mcp.listApprovals());
            return true;
        case "oauth.decide":
            context.writeJson(
                await context.clients.mcp.decideApproval(
                    command.approvalId,
                    command.decision,
                ),
            );
            return true;
        default:
            return false;
    }
}
