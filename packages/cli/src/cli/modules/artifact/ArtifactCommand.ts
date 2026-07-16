import type {
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactShareRevokeResult,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput
} from "@portable-devshell/shared";

import { CliRenderError } from "../../render/CliRenderError.js";

export interface ArtifactCliClient {
    cancelTransfer(transferId: string): Promise<ArtifactTransferResult>;
    createShare(defaultInstance: string, input: ArtifactShareInput): Promise<ArtifactShareResult>;
    getTransfer(transferId: string): Promise<ArtifactTransferRecord>;
    listShares(): Promise<ArtifactShareResult[]>;
    listTransfers(): Promise<ArtifactTransferRecord[]>;
    revokeShare(shareId: string): Promise<ArtifactShareRevokeResult>;
    startTransfer(defaultInstance: string, input: ArtifactTransferStartInput): Promise<ArtifactTransferResult>;
}

export async function executeArtifactCommand(
    args: readonly string[],
    client: ArtifactCliClient,
    stdout: { write(chunk: string): void }
): Promise<void> {
    const [command, ...rest] = args;
    switch (command) {
        case "share":
            writeJson(stdout, await share(client, rest));
            return;
        case "shares":
            expectNoArguments(rest, "artifact shares");
            writeJson(stdout, await client.listShares());
            return;
        case "revoke":
            if (rest.length !== 1) {
                throw usage("artifact revoke requires <shareId>");
            }
            writeJson(stdout, await client.revokeShare(required(rest[0], "shareId")));
            return;
        case "transfer":
            writeJson(stdout, await transfer(client, rest));
            return;
        case "transfers":
            expectNoArguments(rest, "artifact transfers");
            writeJson(stdout, await client.listTransfers());
            return;
        case "help":
        case "--help":
        case "-h":
            expectNoArguments(rest, "artifact help");
            stdout.write(`${artifactUsage()}\n`);
            return;
        case undefined:
            throw usage(artifactUsage());
        default:
            throw usage(`Unknown artifact command: ${command}\n\n${artifactUsage()}`);
    }
}

async function share(client: ArtifactCliClient, args: readonly string[]): Promise<ArtifactShareResult> {
    const parsed = parseOptions(args, new Set(["--authority", "--expires-in"]));
    if (parsed.positionals.length !== 2) {
        throw usage(
            "artifact share requires <instance> <artifact:<handle>|path:<path>> [--expires-in <seconds>] [--authority <instance>]"
        );
    }
    const instance = parsed.positionals[0]!;
    const source = parseShareSource(parsed.positionals[1]!);
    const authority = parsed.options.get("--authority") ?? instance;
    if (authority === "host") {
        throw usage("--authority must name a managed instance.");
    }
    const expiresInSeconds = parsed.options.has("--expires-in")
        ? integerAtLeast(parsed.options.get("--expires-in"), "--expires-in", 60)
        : undefined;
    return await client.createShare(authority, {
        ...source,
        ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
        instance
    });
}

async function transfer(
    client: ArtifactCliClient,
    args: readonly string[]
): Promise<ArtifactTransferRecord | ArtifactTransferResult> {
    const operation = args[0];
    if (operation === "status") {
        if (args.length !== 2) {
            throw usage("artifact transfer status requires <transferId>");
        }
        return await client.getTransfer(required(args[1], "transferId"));
    }
    if (operation === "cancel") {
        if (args.length !== 2) {
            throw usage("artifact transfer cancel requires <transferId>");
        }
        return await client.cancelTransfer(required(args[1], "transferId"));
    }

    const parsed = parseOptions(args, new Set(["--authority", "--overwrite"]));
    if (parsed.positionals.length !== 4) {
        throw usage(
            "artifact transfer requires <source-instance> <artifact:<handle>|path:<path>> <target-instance> <target-path> [--overwrite] [--authority <instance>]"
        );
    }
    const [instance, sourceText, targetInstance, targetPath] = parsed.positionals as [
        string,
        string,
        string,
        string
    ];
    const source = parseTransferSource(sourceText);
    const inferredAuthority = instance === "host" && targetInstance !== "host" ? targetInstance : instance;
    const authority = parsed.options.get("--authority") ?? inferredAuthority;
    if (authority === "host") {
        throw usage("A managed authority instance is required when both transfer endpoints are host.");
    }
    return await client.startTransfer(authority, {
        ...source,
        instance,
        operation: "start",
        overwrite: parsed.flags.has("--overwrite"),
        targetInstance,
        targetPath
    });
}

function parseShareSource(value: string): { handle: string } | { path: string } {
    if (value.startsWith("artifact:") && value.length > "artifact:".length) {
        return { handle: value.slice("artifact:".length) };
    }
    if (value.startsWith("path:") && value.length > "path:".length) {
        return { path: value.slice("path:".length) };
    }
    throw usage("Source must use artifact:<handle> or path:<path>.");
}

function parseTransferSource(value: string): { handle: string } | { sourcePath: string } {
    const source = parseShareSource(value);
    return "handle" in source ? source : { sourcePath: source.path };
}

function parseOptions(
    args: readonly string[],
    supported: ReadonlySet<string>
): { flags: Set<string>; options: Map<string, string>; positionals: string[] } {
    const flags = new Set<string>();
    const options = new Map<string, string>();
    const positionals: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const value = args[index]!;
        if (!value.startsWith("--")) {
            positionals.push(value);
            continue;
        }
        if (!supported.has(value)) {
            throw usage(`Unknown option: ${value}`);
        }
        if (value === "--overwrite") {
            flags.add(value);
            continue;
        }
        const optionValue = args[index + 1];
        if (optionValue === undefined || optionValue.startsWith("--")) {
            throw usage(`${value} requires a value.`);
        }
        options.set(value, optionValue);
        index += 1;
    }
    return { flags, options, positionals };
}

function integerAtLeast(value: string | undefined, option: string, minimum: number): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        throw usage(`${option} must be an integer greater than or equal to ${minimum}.`);
    }
    return parsed;
}

function required(value: string | undefined, name: string): string {
    if (value === undefined || value.length === 0) {
        throw usage(`${name} is required.`);
    }
    return value;
}

function expectNoArguments(args: readonly string[], command: string): void {
    if (args.length !== 0) {
        throw usage(`${command} does not accept arguments.`);
    }
}

function writeJson(stream: { write(chunk: string): void }, value: unknown): void {
    stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function artifactUsage(): string {
    return [
        "Artifact commands:",
        "  devshell artifact share <instance> <artifact:<handle>|path:<path>> [--expires-in <seconds>] [--authority <instance>]",
        "  devshell artifact shares",
        "  devshell artifact revoke <shareId>",
        "  devshell artifact transfer <source-instance> <source> <target-instance> <target-path> [--overwrite] [--authority <instance>]",
        "  devshell artifact transfer status <transferId>",
        "  devshell artifact transfer cancel <transferId>",
        "  devshell artifact transfers"
    ].join("\n");
}

function usage(message: string): CliRenderError {
    return CliRenderError.usage(message);
}
