import { isAbsolute, resolve } from "node:path";

import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type { CliCommandResult } from "@portable-devshell/extension/cli";
import type {
    CliModelCommandInvocationContext,
    CliNativeCommandInvocationContext,
} from "@portable-devshell/extension/cli";

import type { RecallCallQuery, RecallService } from "./RecallService.js";

export const RECALL_USAGE = [
    "Usage:",
    "  devshell recall [workspace]",
    "  devshell recall contexts [workspace]",
    "  devshell recall calls [workspace] [--ctx <ctxId>] [--instance <name>] [--tool <toolName>] [--status <status>] [--limit <n>] [--full]",
].join("\n");

export async function executeRecallNativeCommand(
    service: RecallService,
    argv: readonly string[],
    context: CliNativeCommandInvocationContext,
): Promise<CliCommandResult> {
    context.signal.throwIfAborted();
    if (isHelp(argv)) return text(RECALL_USAGE);
    const command = argv[0];
    if (command === "calls") {
        const parsed = parseCalls(argv.slice(1), true);
        const workspace = nativeWorkspace(
            parsed.workspace,
            context.workingDirectory,
        );
        return json(await service.calls({ ...parsed.query, workspace }));
    }
    if (command === "contexts") {
        if (argv.length > 2)
            throw usageError("recall contexts accepts at most one workspace.");
        return json(
            await service.contexts({
                workspace: nativeWorkspace(argv[1], context.workingDirectory),
            }),
        );
    }
    if (argv.length > 1)
        throw usageError("recall [workspace] accepts only one workspace.");
    return json(
        await service.contexts({
            workspace: nativeWorkspace(command, context.workingDirectory),
        }),
    );
}

export async function executeRecallModelCommand(
    service: RecallService,
    argv: readonly string[],
    context: CliModelCommandInvocationContext,
): Promise<CliCommandResult> {
    context.signal.throwIfAborted();
    if (isHelp(argv)) return text(RECALL_USAGE);
    const command = argv[0];
    if (command === undefined || command === "contexts") {
        if (argv.length > (command === undefined ? 0 : 1))
            throw usageError(
                "Model recall contexts is restricted to the current Workspace.",
            );
        return json(
            await service.contexts({
                instance: context.instance,
                workspace: context.workspace,
            }),
        );
    }
    if (command !== "calls")
        throw usageError(
            "Model recall accepts only contexts or calls for the current Workspace.",
        );
    const parsed = parseCalls(argv.slice(1), false);
    return json(
        await service.calls({
            ...parsed.query,
            instance: context.instance,
            workspace: context.workspace,
        }),
    );
}

function parseCalls(
    argv: readonly string[],
    allowWorkspace: boolean,
): { query: Omit<RecallCallQuery, "workspace">; workspace?: string } {
    let offset = 0;
    let workspace: string | undefined;
    if (argv[0] !== undefined && !argv[0].startsWith("--")) {
        if (!allowWorkspace)
            throw usageError(
                "Model recall calls cannot select another Workspace.",
            );
        workspace = argv[0];
        offset = 1;
    }
    let ctxId: string | undefined;
    let instance: string | undefined;
    let toolName: string | undefined;
    let status: string | undefined;
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
            throw usageError(`${option} requires a value.`);
        index += 1;
        switch (option) {
            case "--ctx":
                ctxId = required(value, "ctxId");
                break;
            case "--instance":
                if (!allowWorkspace)
                    throw usageError(
                        "Model recall calls cannot select another instance.",
                    );
                instance = required(value, "instance");
                break;
            case "--tool":
                toolName = required(value, "tool name");
                break;
            case "--status":
                status = readStatus(value);
                break;
            case "--limit":
                limit = readLimit(value);
                break;
            default:
                throw usageError(`Unknown recall calls option: ${option}`);
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
): string {
    if (requested === undefined) {
        if (workingDirectory === undefined)
            throw usageError(
                "Recall requires a workspace when the CLI working directory is unavailable.",
            );
        return resolve(workingDirectory);
    }
    if (isAbsolute(requested)) return resolve(requested);
    if (workingDirectory === undefined)
        throw usageError(
            "A relative Recall workspace requires the CLI working directory.",
        );
    return resolve(workingDirectory, requested);
}

function readStatus(value: string): string {
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
    throw usageError(`Unsupported tool-call status: ${value}`);
}

function readLimit(value: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
        throw usageError("recall calls --limit requires a positive integer.");
    return parsed;
}

function required(value: string, label: string): string {
    if (value.trim().length === 0) throw usageError(`${label} is required.`);
    return value;
}

function isHelp(argv: readonly string[]): boolean {
    return (
        argv.length === 1 &&
        (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h")
    );
}

function usageError(message: string): Error {
    return new Error(`${message}\n\n${RECALL_USAGE}`);
}

function json(value: ExtensionJsonValue): CliCommandResult {
    return { kind: "json", value };
}

function text(value: string): CliCommandResult {
    return { kind: "text", text: value };
}
