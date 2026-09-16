export function renderToolCall(instance: string, toolName: string): string {
    return `instance: ${instance}\ntool: ${toolName}\n`;
}

import type { JsonValue } from "@portable-devshell/shared";

interface CommandResultLike {
    exitCode: number | null;
    stderr: string;
    stdout: string;
}

export function renderToolResult(result: JsonValue): string {
    if (!isCommandResult(result)) {
        return `${JSON.stringify(result, null, 2)}\n`;
    }

    const sections = [`exitCode: ${result.exitCode}`];

    if (result.stdout.length > 0) {
        sections.push(`stdout:\n${result.stdout.replace(/\n$/u, "")}`);
    }

    if (result.stderr.length > 0) {
        sections.push(`stderr:\n${result.stderr.replace(/\n$/u, "")}`);
    }

    return `${sections.join("\n")}\n`;
}

function isCommandResult(
    value: JsonValue,
): value is JsonValue & CommandResultLike {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Record<string, JsonValue>;
    return (
        (typeof candidate.exitCode === "number" ||
            candidate.exitCode === null) &&
        typeof candidate.stdout === "string" &&
        typeof candidate.stderr === "string"
    );
}

import { CliRenderError } from "../../app/Failure.js";
import type { CliParsedCommand } from "../Parse.js";
import { renderCliTopicUsage } from "../Usage.js";

export function parseApprovalCommand(
    argv: readonly string[],
): CliParsedCommand {
    switch (argv[0]) {
        case "help":
        case "--help":
        case "-h":
            return expectNoExtra(argv, { kind: "help", topic: "approval" });
        case "list":
            return expectApprovalInstance(argv, "approval.list");
        case "show":
            if (argv.length !== 3)
                throw CliRenderError.usage(
                    "approval show requires <instance> <approvalId>",
                );
            return {
                approvalId: required(argv[2], "approvalId is required"),
                instance: required(argv[1], "instance name is required"),
                kind: "approval.show",
            };
        case "approve":
        case "deny":
            if (argv.length < 3)
                throw CliRenderError.usage(
                    `approval ${argv[0]} requires <instance> <approvalId>`,
                );
            return {
                approvalId: required(argv[2], "approvalId is required"),
                decision: argv[0],
                instance: required(argv[1], "instance name is required"),
                kind: "approval.decide",
                ...parseApprovalOptions(argv.slice(3)),
            };
        default:
            throw CliRenderError.usage(
                `${`Unknown approval command: ${argv[0] ?? ""}`.trim()}\n\n${renderCliTopicUsage("approval")}`,
            );
    }
}

export function parseToolCommand(argv: readonly string[]): CliParsedCommand {
    if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h")
        return expectNoExtra(argv, { kind: "help", topic: "tool" });
    if (argv[0] !== "calls" || argv.length < 2)
        throw CliRenderError.usage(
            `tool calls requires <instance> [callId] [--limit <n>] [--before <callId>] [--after <callId>]\n\n${renderCliTopicUsage("tool")}`,
        );
    let offset = 2;
    const callId =
        argv[2] !== undefined && !argv[2].startsWith("--")
            ? required(argv[2], "callId is required")
            : undefined;
    if (callId !== undefined) offset += 1;
    const options = parseToolCallOptions(argv.slice(offset));
    if (
        callId !== undefined &&
        (options.after !== undefined ||
            options.before !== undefined ||
            options.limit !== undefined)
    )
        throw CliRenderError.usage(
            "tool calls does not accept pagination options with an exact callId",
        );
    return {
        ...(callId === undefined ? {} : { callId }),
        instance: required(argv[1], "instance name is required"),
        kind: "tool.calls",
        ...options,
    };
}
function parseToolCallOptions(argv: readonly string[]): {
    after?: string;
    before?: string;
    limit?: number;
} {
    let after, before, limit: number | undefined;
    for (let i = 0; i < argv.length; i += 2) {
        const option = argv[i],
            value = argv[i + 1];
        if (
            value === undefined ||
            (option !== "--after" &&
                option !== "--before" &&
                option !== "--limit")
        )
            throw CliRenderError.usage(
                "tool calls options are --limit <n>, --before <callId>, or --after <callId>",
            );
        if (option === "--after")
            after = required(value, "after callId is required");
        else if (option === "--before")
            before = required(value, "before callId is required");
        else {
            const parsed = Number(value);
            if (!Number.isSafeInteger(parsed) || parsed < 1)
                throw CliRenderError.usage(
                    "tool calls --limit requires a positive integer",
                );
            limit = parsed;
        }
    }
    return {
        ...(after === undefined ? {} : { after }),
        ...(before === undefined ? {} : { before }),
        ...(limit === undefined ? {} : { limit }),
    };
}
function parseApprovalOptions(argv: readonly string[]): {
    policyPatchSource?: string;
    reason?: string;
    remember?: boolean;
} {
    let policyPatchSource: string | undefined,
        reason: string | undefined,
        remember = false;
    for (let i = 0; i < argv.length; i += 1) {
        const option = argv[i]!;
        if (option === "--remember") {
            remember = true;
            continue;
        }
        const value = argv[i + 1];
        if (
            (option !== "--reason" && option !== "--policy-patch") ||
            value === undefined
        )
            throw CliRenderError.usage(
                "approval options are --reason <text>, --remember, or --policy-patch <json>",
            );
        if (option === "--reason")
            reason = required(value, "reason is required");
        else
            policyPatchSource = required(
                value,
                "policy patch source is required",
            );
        i += 1;
    }
    return {
        ...(policyPatchSource === undefined ? {} : { policyPatchSource }),
        ...(reason === undefined ? {} : { reason }),
        ...(remember ? { remember: true } : {}),
    };
}
function expectApprovalInstance(
    argv: readonly string[],
    kind: "approval.list",
): CliParsedCommand {
    if (argv.length !== 2)
        throw CliRenderError.usage("list requires <instance>");
    return { instance: required(argv[1], "instance name is required"), kind };
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
export async function executeToolCommand(
    command: CliParsedCommand,
    context: CliDispatchContext,
): Promise<boolean> {
    switch (command.kind) {
        case "approval.list":
            context.writeJson(
                await context.clients.tool.listApprovals(command.instance),
            );
            return true;
        case "approval.show":
            context.writeJson(
                await context.clients.tool.getApproval(
                    command.instance,
                    command.approvalId,
                ),
            );
            return true;
        case "approval.decide": {
            const policyPatch =
                command.policyPatchSource === undefined
                    ? undefined
                    : await context.readJson(
                          command.policyPatchSource,
                          "approval policy patch",
                      );
            context.writeJson(
                await context.clients.tool.decideApproval(
                    command.instance,
                    command.approvalId,
                    command.decision,
                    {
                        ...(policyPatch === undefined ? {} : { policyPatch }),
                        ...(command.reason === undefined
                            ? {}
                            : { reason: command.reason }),
                        ...(command.remember === undefined
                            ? {}
                            : { remember: command.remember }),
                    },
                ),
            );
            return true;
        }
        case "tool.calls":
            context.writeJson(
                await context.clients.tool.listCalls(
                    command.instance,
                    command.callId === undefined
                        ? {
                              ...(command.after === undefined
                                  ? {}
                                  : { after: command.after }),
                              ...(command.before === undefined
                                  ? {}
                                  : { before: command.before }),
                              limit: command.limit ?? 200,
                          }
                        : { callIds: [command.callId], limit: 1 },
                ),
            );
            return true;
        case "instance.call": {
            const input = await context.readJson(
                command.inputSource,
                "tool input",
            );
            context.stdout.write(
                renderToolCall(command.instance, command.toolName) +
                    renderToolResult(
                        await context.clients.tool.call(
                            command.instance,
                            command.toolName,
                            input,
                            command.workspace,
                        ),
                    ),
            );
            return true;
        }
        default:
            return false;
    }
}
