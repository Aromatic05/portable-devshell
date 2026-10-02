import { isAbsolute, resolve } from "node:path";

import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type {
    CliCommandResult,
    CliModelCommandInvocationContext,
    CliNativeCommandInvocationContext,
} from "@portable-devshell/extension/cli";
import type { ToolCallStatus } from "@portable-devshell/extension/toolcall";

import type {
    RecallCallQuery,
    RecallCallsResult,
    RecallContextsResult,
    RecallService,
} from "./RecallService.js";

export const RECALL_NATIVE_USAGE = [
    "Usage:",
    "  devshell recall [workspace]",
    "  devshell recall contexts [workspace]",
    "  devshell recall calls [workspace] [--ctx <ctxId>] [--instance <name>] [--tool <toolName>] [--status <status>] [--limit <n>] [--full]",
].join("\n");

export const RECALL_MODEL_USAGE = [
    "Usage:",
    "  devshell recall",
    "  devshell recall contexts",
    "  devshell recall calls [--ctx <ctxId>] [--tool <toolName>] [--status <status>] [--limit <n>] [--full]",
    "",
    "Model Recall is restricted to the authoritative current Workspace and instance.",
].join("\n");

export async function executeRecallNativeCommand(
    service: RecallService,
    argv: readonly string[],
    context: CliNativeCommandInvocationContext,
): Promise<CliCommandResult> {
    context.signal.throwIfAborted();
    if (isHelp(argv)) return text(RECALL_NATIVE_USAGE);
    const command = argv[0];
    if (command === "calls") {
        const parsed = parseCalls(argv.slice(1), true, RECALL_NATIVE_USAGE);
        const workspace = nativeWorkspace(
            parsed.workspace,
            context.workingDirectory,
            RECALL_NATIVE_USAGE,
        );
        const result = await service.calls({ ...parsed.query, workspace });
        return structured(result, renderCalls(result));
    }
    if (command === "contexts") {
        if (argv.length > 2)
            throw usageError(
                "recall contexts accepts at most one workspace.",
                RECALL_NATIVE_USAGE,
            );
        const result = await service.contexts({
            workspace: nativeWorkspace(
                argv[1],
                context.workingDirectory,
                RECALL_NATIVE_USAGE,
            ),
        });
        return structured(result, renderContexts(result));
    }
    if (argv.length > 1)
        throw usageError(
            "recall [workspace] accepts only one workspace.",
            RECALL_NATIVE_USAGE,
        );
    const result = await service.contexts({
        workspace: nativeWorkspace(
            command,
            context.workingDirectory,
            RECALL_NATIVE_USAGE,
        ),
    });
    return structured(result, renderContexts(result));
}

export async function executeRecallModelCommand(
    service: RecallService,
    argv: readonly string[],
    context: CliModelCommandInvocationContext,
): Promise<CliCommandResult> {
    context.signal.throwIfAborted();
    if (isHelp(argv)) return text(RECALL_MODEL_USAGE);
    const command = argv[0];
    if (command === undefined || command === "contexts") {
        if (argv.length > (command === undefined ? 0 : 1))
            throw usageError(
                "Model recall contexts is restricted to the current Workspace.",
                RECALL_MODEL_USAGE,
            );
        const result = await service.contexts({
            instance: context.instance,
            workspace: context.workspace,
        });
        return structured(result, renderContexts(result));
    }
    if (command !== "calls")
        throw usageError(
            "Model recall accepts only contexts or calls for the current Workspace.",
            RECALL_MODEL_USAGE,
        );
    const parsed = parseCalls(argv.slice(1), false, RECALL_MODEL_USAGE);
    const result = await service.calls({
        ...parsed.query,
        instance: context.instance,
        workspace: context.workspace,
    });
    return structured(result, renderCalls(result));
}

function parseCalls(
    argv: readonly string[],
    allowWorkspace: boolean,
    usage: string,
): { query: Omit<RecallCallQuery, "workspace">; workspace?: string } {
    let offset = 0;
    let workspace: string | undefined;
    if (argv[0] !== undefined && !argv[0].startsWith("--")) {
        if (!allowWorkspace)
            throw usageError(
                "Model recall calls cannot select another Workspace.",
                usage,
            );
        workspace = argv[0];
        offset = 1;
    }
    let ctxId: string | undefined;
    let instance: string | undefined;
    let toolName: string | undefined;
    let status: ToolCallStatus | undefined;
    let limit: number | undefined;
    let full = false;
    for (let index = offset; index < argv.length; index += 1) {
        const option = argv[index]!;
        if (option === "--full") {
            full = true;
            continue;
        }
        const value = argv[index + 1];
        if (value === undefined)
            throw usageError(`${option} requires a value.`, usage);
        index += 1;
        switch (option) {
            case "--ctx":
                ctxId = required(value, "ctxId", usage);
                break;
            case "--instance":
                if (!allowWorkspace)
                    throw usageError(
                        "Model recall calls cannot select another instance.",
                        usage,
                    );
                instance = required(value, "instance", usage);
                break;
            case "--tool":
                toolName = required(value, "tool name", usage);
                break;
            case "--status":
                status = readStatus(value, usage);
                break;
            case "--limit":
                limit = readLimit(value, usage);
                break;
            default:
                throw usageError(
                    `Unknown recall calls option: ${option}`,
                    usage,
                );
        }
    }
    return {
        query: {
            ...(ctxId === undefined ? {} : { ctxId }),
            full,
            ...(instance === undefined ? {} : { instance }),
            ...(limit === undefined ? {} : { limit }),
            ...(status === undefined ? {} : { status }),
            ...(toolName === undefined ? {} : { toolName }),
        },
        ...(workspace === undefined ? {} : { workspace }),
    };
}

function nativeWorkspace(
    requested: string | undefined,
    workingDirectory: string | undefined,
    usage: string,
): string {
    if (requested === undefined) {
        if (workingDirectory === undefined)
            throw usageError(
                "Recall requires a workspace when the CLI working directory is unavailable.",
                usage,
            );
        return resolve(workingDirectory);
    }
    if (isAbsolute(requested)) return resolve(requested);
    if (workingDirectory === undefined)
        throw usageError(
            "A relative Recall workspace requires the CLI working directory.",
            usage,
        );
    return resolve(workingDirectory, requested);
}

function readStatus(value: string, usage: string): ToolCallStatus {
    if (
        value === "queued" ||
        value === "running" ||
        value === "completed" ||
        value === "failed" ||
        value === "denied" ||
        value === "queueTimeout" ||
        value === "cancelled"
    ) {
        return value;
    }
    throw usageError(`Unsupported tool-call status: ${value}`, usage);
}

function readLimit(value: string, usage: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000)
        throw usageError(
            "recall calls --limit requires an integer between 1 and 1000.",
            usage,
        );
    return parsed;
}

function required(value: string, label: string, usage: string): string {
    if (value.trim().length === 0)
        throw usageError(`${label} is required.`, usage);
    return value;
}

function isHelp(argv: readonly string[]): boolean {
    return (
        argv.length === 1 &&
        (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h")
    );
}

function usageError(message: string, usage: string): Error {
    return new Error(`${message}\n\n${usage}`);
}

function renderContexts(result: RecallContextsResult): string {
    const lines = [
        `Workspace: ${result.workspace}`,
        "CTX\tSTATUS\tLAST ACTIVITY\tCALLS\tINSTANCES",
        ...result.contexts.map((entry) =>
            [
                entry.ctxId,
                entry.status,
                entry.lastToolCallAt ?? entry.lastAccessedAt ?? "-",
                String(entry.toolCalls),
                entry.instances.join(",") || "-",
            ].join("\t"),
        ),
    ];
    appendNotices(lines, result.issues, result.truncatedInstances);
    return lines.join("\n");
}

function renderCalls(result: RecallCallsResult): string {
    const lines = [
        `Workspace: ${result.workspace}`,
        "TIME\tSTATUS\tTOOL\tCTX\tINSTANCE\tPURPOSE",
        ...result.calls.map((call) =>
            [
                call.startedAt,
                call.status,
                call.toolName,
                call.ctxId ?? "-",
                call.instance,
                call.purpose ?? call.explanation ?? call.inputSummary,
            ].join("\t"),
        ),
    ];
    appendNotices(lines, result.issues, []);
    return lines.join("\n");
}

function appendNotices(
    lines: string[],
    issues: RecallContextsResult["issues"],
    truncatedInstances: readonly string[],
): void {
    for (const issue of issues)
        lines.push(`warning: ${issue.instance}: ${issue.message}`);
    if (truncatedInstances.length > 0)
        lines.push(
            `warning: context history scan reached its bound for: ${truncatedInstances.join(", ")}`,
        );
}

function structured(
    value: RecallContextsResult | RecallCallsResult,
    rendered: string,
): CliCommandResult {
    return {
        kind: "json",
        text: rendered,
        value: value as unknown as ExtensionJsonValue,
    };
}

function text(value: string): CliCommandResult {
    return { kind: "text", text: value };
}
