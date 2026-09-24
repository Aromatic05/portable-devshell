import {
    generateOAuth2ApprovalToken,
    type ConfigView,
} from "@portable-devshell/shared";

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
        case "approval":
            return parseOAuthApprovalCommand(argv.slice(1));
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
function parseOAuthApprovalCommand(argv: readonly string[]): CliParsedCommand {
    switch (argv[0]) {
        case undefined:
        case "status":
            return expectNoExtraOrEmpty(argv, { kind: "oauth.approval.status" });
        case "tui":
            return expectNoExtra(argv, { kind: "oauth.approval.tui" });
        case "token":
            return expectNoExtra(argv, { kind: "oauth.approval.token" });
        case "rotate":
            return expectNoExtra(argv, { kind: "oauth.approval.rotate" });
        default:
            throw CliRenderError.usage(
                `${`Unknown oauth approval command: ${argv[0] ?? ""}`.trim()}\n\n${renderCliTopicUsage("oauth")}`,
            );
    }
}

function expectNoExtraOrEmpty<T extends CliParsedCommand>(
    argv: readonly string[],
    value: T,
): T {
    if (argv.length > 1)
        throw CliRenderError.usage(`Unexpected arguments for ${argv[0]}`);
    return value;
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
        case "oauth.approval.status":
            return await showApprovalStatus(context);
        case "oauth.approval.tui":
            await context.clients.config.update({
                mcp: { oauth2: { approval: "tui" } },
            });
            context.writeValue(
                { mode: "tui", tokenConfigured: false },
                "OAuth2 approval mode: tui\n",
            );
            return true;
        case "oauth.approval.token":
            return await enableTokenApproval(context, false);
        case "oauth.approval.rotate":
            return await enableTokenApproval(context, true);
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


async function showApprovalStatus(context: CliDispatchContext): Promise<true> {
    const config = (await context.clients.config.get()) as unknown as ConfigView;
    const mode = config.mcp.oauth2.approval;
    const tokenConfigured =
        mode === "token" && typeof config.mcp.oauth2.token === "string";
    context.writeValue(
        { mode, tokenConfigured },
        `OAuth2 approval mode: ${mode}\nToken: ${tokenConfigured ? "configured" : "not configured"}\n`,
    );
    return true;
}

async function enableTokenApproval(
    context: CliDispatchContext,
    rotate: boolean,
): Promise<true> {
    const config = (await context.clients.config.get()) as unknown as ConfigView;
    const alreadyConfigured =
        config.mcp.oauth2.approval === "token" &&
        typeof config.mcp.oauth2.token === "string";
    if (alreadyConfigured && !rotate) {
        context.writeValue(
            { mode: "token", tokenConfigured: true },
            "OAuth2 approval mode: token\nToken: configured\n",
        );
        return true;
    }
    const token = generateOAuth2ApprovalToken();
    await context.clients.config.update({
        mcp: { oauth2: { approval: "token", token } },
    });
    context.writeValue(
        { mode: "token", token, tokenConfigured: true },
        `OAuth2 approval mode: token\nApproval token: ${token}\nSave this token now; it will be masked in later config reads.\n`,
    );
    return true;
}
