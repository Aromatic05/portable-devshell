import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type {
    CliCommandResult,
    CliNativeCommandInvocationContext,
} from "@portable-devshell/extension/cli";

import type { AccessEndpointRecord, AccessRuntime } from "./AccessRuntime.js";

export const ACCESS_USAGE = [
    "Usage:",
    "  devshell access list",
    "  devshell access show <id>",
    "  devshell access set '<endpoint-json>'",
    "  devshell access enable <id>",
    "  devshell access disable <id>",
    "  devshell access remove <id>",
    "  devshell access reload",
    "  devshell access web",
].join("\n");

export async function executeAccessCommand(
    runtime: AccessRuntime,
    argv: readonly string[],
    context: CliNativeCommandInvocationContext,
): Promise<CliCommandResult> {
    context.signal.throwIfAborted();
    const command = argv[0];
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
        if (argv.length > 1) throw usageError("Access help does not accept extra arguments.");
        return { kind: "text", text: ACCESS_USAGE };
    }
    switch (command) {
        case "list":
            expectLength(argv, 1, "access list");
            return json(runtime.list().map(recordToJson));
        case "show": {
            expectLength(argv, 2, "access show <id>");
            const record = runtime.get(required(argv[1], "endpoint id is required"));
            return json(record === undefined ? null : recordToJson(record));
        }
        case "set": {
            requireLocalOwner(context);
            expectLength(argv, 2, "access set '<endpoint-json>'");
            const source = required(argv[1], "endpoint JSON is required");
            let value: unknown;
            try {
                value = JSON.parse(source);
            } catch (error) {
                throw usageError(
                    `Access endpoint JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
            return json(recordToJson(await runtime.upsert(value as ExtensionJsonValue)));
        }
        case "enable":
        case "disable": {
            requireLocalOwner(context);
            expectLength(argv, 2, `access ${command} <id>`);
            return json(
                recordToJson(
                    await runtime.setEnabled(
                        required(argv[1], "endpoint id is required"),
                        command === "enable",
                    ),
                ),
            );
        }
        case "remove":
            requireLocalOwner(context);
            expectLength(argv, 2, "access remove <id>");
            return json(
                await runtime.remove(required(argv[1], "endpoint id is required")),
            );
        case "reload":
            requireLocalOwner(context);
            expectLength(argv, 1, "access reload");
            await runtime.reload();
            return json({ reloaded: true });
        case "web":
            expectLength(argv, 1, "access web");
            return json({ available: true, webPath: "extensions/access/" });
        default:
            throw usageError(`Unknown access command: ${command}`);
    }
}

function recordToJson(record: AccessEndpointRecord): ExtensionJsonValue {
    return {
        enabled: record.enabled,
        ...(record.error === undefined ? {} : { error: record.error }),
        id: record.id,
        ...(record.origin === undefined ? {} : { origin: record.origin }),
        provider: record.provider,
        ...(record.publicUrl === undefined ? {} : { publicUrl: record.publicUrl }),
        state: record.state,
        target: record.target,
    };
}

function json(value: ExtensionJsonValue): CliCommandResult {
    return { kind: "json", value };
}

function requireLocalOwner(context: CliNativeCommandInvocationContext): void {
    if (context.localOwner) return;
    throw new Error("Access mutations are restricted to the local owner CLI.");
}

function expectLength(argv: readonly string[], length: number, usage: string): void {
    if (argv.length !== length) throw usageError(`Usage: devshell ${usage}`);
}

function required(value: string | undefined, message: string): string {
    if (value !== undefined && value.trim().length > 0) return value.trim();
    throw usageError(message);
}

function usageError(message: string): TypeError {
    return new TypeError(`${message}\n\n${ACCESS_USAGE}`);
}
