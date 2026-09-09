import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type {
    ExtensionArtifactCapability,
    ExtensionArtifactShareInput,
    ExtensionArtifactSource,
    ExtensionArtifactTransferInput
} from "@portable-devshell/extension/artifact";
import type { CliCommandResult } from "@portable-devshell/extension/cli";

export const ARTIFACT_USAGE = [
    "Artifact commands:",
    "  devshell artifact share <instance> <artifact:<handle>|path:<path>> [--workspace <absolute-path>] [--expires-in <seconds>] [--max-downloads <count>] [--authority <instance>]",
    "  devshell artifact shares",
    "  devshell artifact revoke <shareId>",
    "  devshell artifact transfer <source-instance> <source> <target-instance> <target-path> --target-workspace <absolute-path> [--source-workspace <absolute-path>] [--overwrite] [--authority <instance>]",
    "  devshell artifact transfer status <transferId>",
    "  devshell artifact transfer cancel <transferId>",
    "  devshell artifact transfers",
    "",
    "Path sources and targets require explicit workspace options; relative target paths resolve inside the target workspace."
].join("\n");

export async function executeArtifactCommand(
    artifacts: ExtensionArtifactCapability,
    args: readonly string[],
    signal: AbortSignal
): Promise<CliCommandResult> {
    signal.throwIfAborted();
    const [command, ...rest] = args;
    switch (command) {
        case "share":
            return json(await share(artifacts, rest));
        case "shares":
            expectNoArguments(rest, "artifact shares");
            return json((await artifacts.listShares()).map((share) => ({ ...share, url: "[redacted]" })));
        case "revoke":
            if (rest.length !== 1) throw usage("artifact revoke requires <shareId>");
            return json(await artifacts.revokeShare(required(rest[0], "shareId")));
        case "transfer":
            return json(await transfer(artifacts, rest));
        case "transfers":
            expectNoArguments(rest, "artifact transfers");
            return json(await artifacts.listTransfers());
        case "help":
        case "--help":
        case "-h":
            expectNoArguments(rest, "artifact help");
            return { kind: "text", text: ARTIFACT_USAGE };
        case undefined:
            throw usage(ARTIFACT_USAGE);
        default:
            throw usage(`Unknown artifact command: ${command}\n\n${ARTIFACT_USAGE}`);
    }
}

async function share(
    artifacts: ExtensionArtifactCapability,
    args: readonly string[]
): Promise<Awaited<ReturnType<ExtensionArtifactCapability["createShare"]>>> {
    const parsed = parseOptions(args, new Set(["--authority", "--expires-in", "--max-downloads", "--workspace"]));
    if (parsed.positionals.length !== 2) {
        throw usage("artifact share requires <instance> <artifact:<handle>|path:<path>> [--workspace <absolute-path>] [--expires-in <seconds>] [--max-downloads <count>] [--authority <instance>]");
    }
    const instance = required(parsed.positionals[0], "instance");
    const source = parseSource(parsed.positionals[1]!, instance, parsed.options.get("--workspace"), "--workspace");
    const authorityInstance = parsed.options.get("--authority") ?? instance;
    if (authorityInstance === "host") throw usage("--authority must name a managed instance.");
    const input: ExtensionArtifactShareInput = {
        authorityInstance,
        ...(parsed.options.has("--expires-in")
            ? { expiresInSeconds: integerAtLeast(parsed.options.get("--expires-in"), "--expires-in", 60) }
            : {}),
        ...(parsed.options.has("--max-downloads")
            ? { maxDownloads: integerAtLeast(parsed.options.get("--max-downloads"), "--max-downloads", 1) }
            : {}),
        source
    };
    return await artifacts.createShare(input);
}

async function transfer(
    artifacts: ExtensionArtifactCapability,
    args: readonly string[]
): Promise<unknown> {
    const operation = args[0];
    if (operation === "status") {
        if (args.length !== 2) throw usage("artifact transfer status requires <transferId>");
        return await artifacts.getTransfer(required(args[1], "transferId"));
    }
    if (operation === "cancel") {
        if (args.length !== 2) throw usage("artifact transfer cancel requires <transferId>");
        return await artifacts.cancelTransfer(required(args[1], "transferId"));
    }

    const parsed = parseOptions(args, new Set(["--authority", "--overwrite", "--source-workspace", "--target-workspace"]));
    if (parsed.positionals.length !== 4) {
        throw usage("artifact transfer requires <source-instance> <artifact:<handle>|path:<path>> <target-instance> <target-path> --target-workspace <absolute-path> [--source-workspace <absolute-path>] [--overwrite] [--authority <instance>]");
    }
    const [sourceInstance, sourceText, targetInstance, targetPath] = parsed.positionals as [string, string, string, string];
    const source = parseSource(sourceText, sourceInstance, parsed.options.get("--source-workspace"), "--source-workspace");
    const targetWorkspace = required(parsed.options.get("--target-workspace"), "--target-workspace");
    const inferredAuthority = sourceInstance === "host" && targetInstance !== "host" ? targetInstance : sourceInstance;
    const authorityInstance = parsed.options.get("--authority") ?? inferredAuthority;
    if (authorityInstance === "host") {
        throw usage("A managed authority instance is required when both transfer endpoints are host.");
    }
    const input: ExtensionArtifactTransferInput = {
        authorityInstance,
        ...(parsed.flags.has("--overwrite") ? { overwrite: true } : {}),
        source,
        target: {
            instance: targetInstance,
            path: normalizeTargetPath(targetPath),
            workspace: targetWorkspace
        }
    };
    return await artifacts.startTransfer(input);
}

function parseSource(
    value: string,
    instance: string,
    workspace: string | undefined,
    workspaceOption: string
): ExtensionArtifactSource {
    if (value.startsWith("artifact:") && value.length > "artifact:".length) {
        return { handle: value.slice("artifact:".length), instance };
    }
    if (value.startsWith("path:") && value.length > "path:".length) {
        return {
            instance,
            path: value.slice("path:".length),
            workspace: required(workspace, workspaceOption)
        };
    }
    throw usage("Source must use artifact:<handle> or path:<path>.");
}

function normalizeTargetPath(value: string): string {
    const path = required(value, "targetPath");
    if (path.startsWith("/") || path.startsWith("./") || /^[A-Za-z]:[\\/]/u.test(path)) return path;
    if (path.startsWith(".\\")) return `./${path.slice(2)}`;
    return `./${path}`;
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
        if (!supported.has(value)) throw usage(`Unknown option: ${value}`);
        if (value === "--overwrite") {
            flags.add(value);
            continue;
        }
        const optionValue = args[index + 1];
        if (optionValue === undefined || optionValue.startsWith("--")) throw usage(`${value} requires a value.`);
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
    if (value !== undefined && value.length > 0) return value;
    throw usage(`${name} is required.`);
}

function expectNoArguments(args: readonly string[], command: string): void {
    if (args.length !== 0) throw usage(`${command} does not accept arguments.`);
}

function json(value: unknown): CliCommandResult {
    return { kind: "json", value: JSON.parse(JSON.stringify(value)) as ExtensionJsonValue };
}

function usage(message: string): TypeError {
    return new TypeError(message);
}
