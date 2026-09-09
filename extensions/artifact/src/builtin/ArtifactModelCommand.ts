import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type {
    ExtensionArtifactCapability,
    ExtensionArtifactShareRecord,
    ExtensionArtifactTransferRecord
} from "@portable-devshell/extension/artifact";
import type { CliCommandResult, CliModelCommandInvocationContext } from "@portable-devshell/extension/cli";

export const ARTIFACT_MODEL_USAGE = [
    "Artifact commands for the current model Context:",
    "  devshell artifact share <artifact:<handle>|path:<path>> [--expires-in <seconds>] [--max-downloads <count>]",
    "  devshell artifact shares",
    "  devshell artifact revoke <shareId>",
    "  devshell artifact transfer status <transferId>",
    "  devshell artifact transfer cancel <transferId>",
    "  devshell artifact transfers",
    "",
    "Model commands are pinned to the current instance and Workspace. Cross-instance transfer creation is native-owner CLI only."
].join("\n");

export async function executeArtifactModelCommand(
    artifacts: ExtensionArtifactCapability,
    args: readonly string[],
    invocation: CliModelCommandInvocationContext
): Promise<CliCommandResult> {
    invocation.signal.throwIfAborted();
    const [command, ...rest] = args;
    switch (command) {
        case "share":
            return json(await share(artifacts, rest, invocation));
        case "shares":
            expect(rest, 0, "artifact shares");
            return json((await artifacts.listShares())
                .filter((record) => shareBelongsToContext(record, invocation))
                .map((record) => ({ ...record, url: "[redacted]" })));
        case "revoke": {
            expect(rest, 1, "artifact revoke <shareId>");
            const shareId = required(rest[0], "shareId");
            const shareRecord = (await artifacts.listShares()).find((record) => record.shareId === shareId);
            if (shareRecord === undefined || !shareBelongsToContext(shareRecord, invocation)) {
                throw unavailable("share", shareId);
            }
            return json(await artifacts.revokeShare(shareId));
        }
        case "transfer":
            return json(await transfer(artifacts, rest, invocation));
        case "transfers":
            expect(rest, 0, "artifact transfers");
            return json((await artifacts.listTransfers()).filter((record) => transferBelongsToContext(record, invocation)));
        case "help":
        case "--help":
        case "-h":
            expect(rest, 0, "artifact help");
            return { kind: "text", text: ARTIFACT_MODEL_USAGE };
        case undefined:
            throw usage(ARTIFACT_MODEL_USAGE);
        default:
            throw usage(`Unknown artifact model command: ${command}\n\n${ARTIFACT_MODEL_USAGE}`);
    }
}

async function share(
    artifacts: ExtensionArtifactCapability,
    args: readonly string[],
    invocation: CliModelCommandInvocationContext
) {
    const parsed = parseOptions(args, new Set(["--expires-in", "--max-downloads"]));
    if (parsed.positionals.length !== 1) {
        throw usage("artifact share requires <artifact:<handle>|path:<path>> [--expires-in <seconds>] [--max-downloads <count>]");
    }
    const sourceText = parsed.positionals[0]!;
    const source = sourceText.startsWith("artifact:") && sourceText.length > "artifact:".length
        ? { handle: sourceText.slice("artifact:".length), instance: invocation.instance }
        : sourceText.startsWith("path:") && sourceText.length > "path:".length
            ? { instance: invocation.instance, path: sourceText.slice("path:".length), workspace: invocation.workspace }
            : undefined;
    if (source === undefined) throw usage("Source must use artifact:<handle> or path:<path>.");
    return await artifacts.createShare({
        authorityInstance: invocation.instance,
        ...(parsed.options.has("--expires-in")
            ? { expiresInSeconds: integerAtLeast(parsed.options.get("--expires-in"), "--expires-in", 60) }
            : {}),
        ...(parsed.options.has("--max-downloads")
            ? { maxDownloads: integerAtLeast(parsed.options.get("--max-downloads"), "--max-downloads", 1) }
            : {}),
        source
    });
}

async function transfer(
    artifacts: ExtensionArtifactCapability,
    args: readonly string[],
    invocation: CliModelCommandInvocationContext
): Promise<ExtensionArtifactTransferRecord | unknown> {
    const operation = args[0];
    if (operation !== "status" && operation !== "cancel") {
        throw usage("Model Artifact commands do not create cross-instance transfers. Use artifact transfer status|cancel <transferId>.");
    }
    expect(args, 2, `artifact transfer ${operation} <transferId>`);
    const transferId = required(args[1], "transferId");
    const record = await artifacts.getTransfer(transferId);
    if (!transferBelongsToContext(record, invocation)) throw unavailable("transfer", transferId);
    return operation === "status" ? record : await artifacts.cancelTransfer(transferId);
}

function shareBelongsToContext(
    record: ExtensionArtifactShareRecord,
    invocation: CliModelCommandInvocationContext
): boolean {
    if (record.source.instance !== invocation.instance) return false;
    return record.source.workspace === undefined || record.source.workspace === invocation.workspace;
}

function transferBelongsToContext(
    record: ExtensionArtifactTransferRecord,
    invocation: CliModelCommandInvocationContext
): boolean {
    if (record.source.instance !== invocation.instance || record.target.instance !== invocation.instance) return false;
    if (record.source.workspace !== undefined && record.source.workspace !== invocation.workspace) return false;
    return record.target.workspace === invocation.workspace;
}

function parseOptions(
    args: readonly string[],
    supported: ReadonlySet<string>
): { options: Map<string, string>; positionals: string[] } {
    const options = new Map<string, string>();
    const positionals: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const value = args[index]!;
        if (!value.startsWith("--")) {
            positionals.push(value);
            continue;
        }
        if (!supported.has(value)) throw usage(`Unknown option: ${value}`);
        const optionValue = args[++index];
        if (optionValue === undefined || optionValue.startsWith("--")) throw usage(`${value} requires a value.`);
        options.set(value, optionValue);
    }
    return { options, positionals };
}

function integerAtLeast(value: string | undefined, option: string, minimum: number): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        throw usage(`${option} must be an integer greater than or equal to ${minimum}.`);
    }
    return parsed;
}

function expect(values: readonly string[], length: number, usageText: string): void {
    if (values.length !== length) throw usage(`Usage: devshell ${usageText}`);
}

function required(value: string | undefined, label: string): string {
    if (value !== undefined && value.length > 0) return value;
    throw usage(`${label} is required.`);
}

function unavailable(kind: string, id: string): Error {
    return new Error(`Artifact ${kind} ${id} is unavailable in the current model Context.`);
}

function json(value: unknown): CliCommandResult {
    return { kind: "json", value: JSON.parse(JSON.stringify(value)) as ExtensionJsonValue };
}

function usage(message: string): TypeError {
    return new TypeError(message);
}
