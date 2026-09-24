import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type {
    CliCommandResult,
    CliNativeCommandInvocationContext,
} from "@portable-devshell/extension/cli";

import type { AccessEndpointRecord, AccessRuntime } from "./AccessRuntime.js";

export const ACCESS_USAGE = [
    "Usage:",
    "  devshell access cloudflare",
    "  devshell access cloudflare url <https://hostname>",
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
        case "cloudflare":
            requireLocalOwner(context);
            return await configureCloudflare(runtime, argv.slice(1), context);
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

const cloudflareEndpointId = "cloudflare-mcp";

async function configureCloudflare(
    runtime: AccessRuntime,
    argv: readonly string[],
    context: CliNativeCommandInvocationContext,
): Promise<CliCommandResult> {
    if (argv[0] === "url") {
        expectLength(argv, 2, "access cloudflare url <https://hostname>");
        const record = await runtime.setPublicUrl(
            cloudflareEndpointId,
            required(argv[1], "public URL is required"),
        );
        return { kind: "text", text: cloudflareConfiguredText(record) };
    }
    expectLength(argv, 0, "access cloudflare");
    const token = await readSecret(context, "Cloudflare tunnel token");
    const record = await runtime.upsert({
        enabled: true,
        id: cloudflareEndpointId,
        provider: "cloudflared",
        target: "mcp",
        token,
    });
    if (record.state !== "running") {
        throw new Error(
            `Cloudflare tunnel failed to start${record.error === undefined ? "." : `: ${record.error}`}`,
        );
    }
    return { kind: "text", text: cloudflareConfiguredText(record) };
}

function cloudflareConfiguredText(record: AccessEndpointRecord): string {
    const lines = [
        "Cloudflare tunnel configured.",
        "",
        `Service URL: ${record.origin ?? "waiting for the MCP endpoint"}`,
    ];
    if (record.publicUrl !== undefined) {
        lines.push(`Public URL: ${record.publicUrl}`);
    } else {
        lines.push(
            "",
            "In Cloudflare, add a Published application route:",
            "  Hostname: <your hostname>",
            `  Service:  ${record.origin ?? "the Service URL shown above"}`,
            "",
            "DevShell will detect the hostname automatically after Cloudflare sends the route configuration.",
            "If automatic detection is unavailable, run:",
            "  devshell access cloudflare url https://<your-hostname>",
        );
    }
    return `${lines.join("\n")}\n`;
}

async function readSecret(
    context: CliNativeCommandInvocationContext,
    label: string,
): Promise<string> {
    const io = context.io;
    if (io === undefined)
        throw usageError(`${label} requires interactive CLI input.`);
    await io.writeStderr(`${label}: `);
    await io.requestInput({ raw: true });
    const bytes: number[] = [];
    while (true) {
        context.signal.throwIfAborted();
        const chunk = await io.readInput();
        if (chunk === undefined) break;
        for (const byte of chunk) {
            if (byte === 3) throw new Error("Input cancelled.");
            if (byte === 10 || byte === 13) {
                await io.writeStderr("\n");
                const value = Buffer.from(bytes).toString("utf8").trim();
                if (value.length === 0) throw usageError(`${label} is required.`);
                return value;
            }
            if (byte === 8 || byte === 127) {
                bytes.pop();
                continue;
            }
            bytes.push(byte);
        }
    }
    await io.writeStderr("\n");
    const value = Buffer.from(bytes).toString("utf8").trim();
    if (value.length === 0) throw usageError(`${label} is required.`);
    return value;
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
