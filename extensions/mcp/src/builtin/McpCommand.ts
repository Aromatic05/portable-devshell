import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type {
    CliCommandResult,
    CliModelCommandInvocationContext,
    CliNativeCommandInvocationContext
} from "@portable-devshell/extension/cli";

import { McpHttpClientFactory, type McpClientFactory } from "./McpClientRuntime.js";
import { McpProfileStore, validateMcpProfile } from "./McpProfileStore.js";

export const MCP_USAGE = [
    "Usage:",
    "  devshell mcp list",
    "  devshell mcp get <name>",
    "  devshell mcp add <name> <url>",
    "  devshell mcp remove <name>",
    "  devshell mcp tools <name>",
    "  devshell mcp call <name> <tool> [json-arguments]",
    "",
    "Profiles are Extension-owned Streamable HTTP endpoints. Authentication is not configured in this first client slice."
].join("\n");

export const MCP_MODEL_USAGE = [
    "Usage:",
    "  devshell mcp list",
    "  devshell mcp get <name>",
    "  devshell mcp tools <name>",
    "  devshell mcp call <name> <tool> [json-arguments]",
    "",
    "Profile add/remove is available only from the native owner CLI."
].join("\n");

export interface McpCommandRuntime {
    clients: McpClientFactory;
    profiles: McpProfileStore;
}

export function createMcpCommandRuntime(stateDirectory: string, version: string): McpCommandRuntime {
    return {
        clients: new McpHttpClientFactory(version),
        profiles: new McpProfileStore(stateDirectory)
    };
}

export async function executeMcpCommand(
    runtime: McpCommandRuntime,
    argv: readonly string[],
    invocation: CliNativeCommandInvocationContext
): Promise<CliCommandResult> {
    invocation.signal.throwIfAborted();
    if (help(argv)) {
        if (argv.length > 1) throw usageError("mcp help does not accept extra arguments");
        return { kind: "text", text: MCP_USAGE };
    }
    switch (argv[0]) {
        case "list":
            expect(argv, 1, "mcp list", usageError);
            return json(await runtime.profiles.list());
        case "get":
            expect(argv, 2, "mcp get <name>", usageError);
            return json(await requireProfile(runtime.profiles, argv[1]!));
        case "add":
            requireLocalOwner(invocation);
            expect(argv, 3, "mcp add <name> <url>", usageError);
            return json(await runtime.profiles.add(validateMcpProfile(argv[1]!, argv[2]!)));
        case "remove":
            requireLocalOwner(invocation);
            expect(argv, 2, "mcp remove <name>", usageError);
            return json(await runtime.profiles.remove(argv[1]!));
        case "tools":
            return await tools(runtime, argv, invocation.signal, usageError);
        case "call":
            return await call(runtime, argv, invocation.signal, usageError);
        default:
            throw usageError(`Unknown mcp command: ${argv[0]}`);
    }
}

export async function executeMcpModelCommand(
    runtime: McpCommandRuntime,
    argv: readonly string[],
    invocation: CliModelCommandInvocationContext
): Promise<CliCommandResult> {
    invocation.signal.throwIfAborted();
    if (help(argv)) {
        if (argv.length > 1) throw modelUsageError("mcp help does not accept extra arguments");
        return { kind: "text", text: MCP_MODEL_USAGE };
    }
    switch (argv[0]) {
        case "list":
            expect(argv, 1, "mcp list", modelUsageError);
            return json(await runtime.profiles.list());
        case "get":
            expect(argv, 2, "mcp get <name>", modelUsageError);
            return json(await requireProfile(runtime.profiles, argv[1]!));
        case "tools":
            return await tools(runtime, argv, invocation.signal, modelUsageError);
        case "call":
            return await call(runtime, argv, invocation.signal, modelUsageError);
        case "add":
        case "remove":
            throw modelUsageError(`mcp ${argv[0]} is available only from the native owner CLI`);
        default:
            throw modelUsageError(`Unknown mcp command: ${argv[0]}`);
    }
}

async function tools(
    runtime: McpCommandRuntime,
    argv: readonly string[],
    signal: AbortSignal,
    error: (message: string) => TypeError
): Promise<CliCommandResult> {
    expect(argv, 2, "mcp tools <name>", error);
    const profile = await requireProfile(runtime.profiles, argv[1]!);
    return json(await withClient(runtime.clients, profile, signal, async (client) =>
        await client.listTools(signal)
    ));
}

async function call(
    runtime: McpCommandRuntime,
    argv: readonly string[],
    signal: AbortSignal,
    error: (message: string) => TypeError
): Promise<CliCommandResult> {
    if (argv.length < 3 || argv.length > 4) {
        throw error("Usage: devshell mcp call <name> <tool> [json-arguments]");
    }
    const profile = await requireProfile(runtime.profiles, argv[1]!);
    const input = parseArguments(argv[3], error);
    return json(await withClient(runtime.clients, profile, signal, async (client) =>
        await client.callTool(argv[2]!, input, signal)
    ));
}

async function withClient<T>(
    factory: McpClientFactory,
    profile: { name: string; url: string },
    signal: AbortSignal,
    operation: (client: Awaited<ReturnType<McpClientFactory["connect"]>>) => Promise<T>
): Promise<T> {
    const client = await factory.connect(profile, signal);
    try {
        return await operation(client);
    } finally {
        await client.close();
    }
}

async function requireProfile(store: McpProfileStore, name: string) {
    const profile = await store.get(name);
    if (profile === undefined) throw new Error(`MCP profile ${name} does not exist.`);
    return profile;
}

function parseArguments(
    text: string | undefined,
    error: (message: string) => TypeError
): Record<string, ExtensionJsonValue> {
    if (text === undefined) return {};
    let value: unknown;
    try {
        value = JSON.parse(text) as unknown;
    } catch {
        throw error("mcp call json-arguments must be valid JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw error("mcp call json-arguments must be a JSON object");
    }
    return value as Record<string, ExtensionJsonValue>;
}

function help(argv: readonly string[]): boolean {
    return argv.length === 0 || ["help", "--help", "-h"].includes(argv[0] ?? "");
}

function expect(
    argv: readonly string[],
    length: number,
    usage: string,
    error: (message: string) => TypeError
): void {
    if (argv.length !== length) throw error(`Usage: devshell ${usage}`);
}

function requireLocalOwner(invocation: CliNativeCommandInvocationContext): void {
    if (!invocation.localOwner) throw new Error("MCP profile mutations are restricted to the local owner CLI.");
}

function json(value: unknown): CliCommandResult {
    return { kind: "json", value: JSON.parse(JSON.stringify(value)) as ExtensionJsonValue };
}

function usageError(message: string): TypeError {
    return new TypeError(`${message}\n\n${MCP_USAGE}`);
}

function modelUsageError(message: string): TypeError {
    return new TypeError(`${message}\n\n${MCP_MODEL_USAGE}`);
}
