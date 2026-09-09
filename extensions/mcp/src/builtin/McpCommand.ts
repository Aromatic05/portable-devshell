import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type {
    CliNativeCommandInvocationContext,
    CliCommandResult
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
    if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0] ?? "")) {
        if (argv.length > 1) throw usageError("mcp help does not accept extra arguments");
        return { kind: "text", text: MCP_USAGE };
    }
    const command = argv[0]!;
    switch (command) {
        case "list":
            expect(argv, 1, "mcp list");
            return json(await runtime.profiles.list());
        case "get": {
            expect(argv, 2, "mcp get <name>");
            const profile = await requireProfile(runtime.profiles, argv[1]!);
            return json(profile);
        }
        case "add": {
            requireLocalOwner(invocation);
            expect(argv, 3, "mcp add <name> <url>");
            return json(await runtime.profiles.add(validateMcpProfile(argv[1]!, argv[2]!)));
        }
        case "remove": {
            requireLocalOwner(invocation);
            expect(argv, 2, "mcp remove <name>");
            return json(await runtime.profiles.remove(argv[1]!));
        }
        case "tools": {
            expect(argv, 2, "mcp tools <name>");
            const profile = await requireProfile(runtime.profiles, argv[1]!);
            return json(await withClient(runtime.clients, profile, invocation.signal, async (client) =>
                await client.listTools(invocation.signal)
            ));
        }
        case "call": {
            if (argv.length < 3 || argv.length > 4) throw usageError("Usage: devshell mcp call <name> <tool> [json-arguments]");
            const profile = await requireProfile(runtime.profiles, argv[1]!);
            const input = parseArguments(argv[3]);
            return json(await withClient(runtime.clients, profile, invocation.signal, async (client) =>
                await client.callTool(argv[2]!, input, invocation.signal)
            ));
        }
        default:
            throw usageError(`Unknown mcp command: ${command}`);
    }
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

function parseArguments(text: string | undefined): Record<string, ExtensionJsonValue> {
    if (text === undefined) return {};
    let value: unknown;
    try {
        value = JSON.parse(text) as unknown;
    } catch (error) {
        throw usageError("mcp call json-arguments must be valid JSON", error);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw usageError("mcp call json-arguments must be a JSON object");
    }
    return value as Record<string, ExtensionJsonValue>;
}

function expect(argv: readonly string[], length: number, usage: string): void {
    if (argv.length !== length) throw usageError(`Usage: devshell ${usage}`);
}

function requireLocalOwner(invocation: CliNativeCommandInvocationContext): void {
    if (!invocation.localOwner) throw new Error("MCP profile mutations are restricted to the local owner CLI.");
}

function json(value: unknown): CliCommandResult {
    return { kind: "json", value: JSON.parse(JSON.stringify(value)) as ExtensionJsonValue };
}

function usageError(message: string, cause?: unknown): TypeError {
    return new TypeError(`${message}\n\n${MCP_USAGE}`, cause === undefined ? undefined : { cause });
}
