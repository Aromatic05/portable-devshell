import type {
    CliCommandResult,
    CliModelCommandInvocationContext,
    CliNativeCommandInvocationContext,
} from "@portable-devshell/extension/cli";
import type { MailingService } from "./Service.js";

const modelUsage = [
    "Usage:",
    "  devshell memory                     Show the current Memory binding",
    "  devshell memory init <name>         Create and bind a new Memory",
    "  devshell memory inherit <name>      Bind an existing Memory without copying it",
    "  devshell memory list                List existing Memories",
    "  devshell memory release             Unbind without deleting any files",
].join("\n");

const nativeUsage = [
    "Usage (local Control owner):",
    "  devshell memory list <instance> <workspace>",
    "  devshell memory init <instance> <workspace> <ctxId> <name>",
    "  devshell memory inherit <instance> <workspace> <ctxId> <name>",
    "  devshell memory status <instance> <workspace> <ctxId>",
    "  devshell memory release <instance> <workspace> <ctxId>",
].join("\n");

function json(value: unknown): CliCommandResult {
    return { kind: "json", value: value as import("@portable-devshell/extension").ExtensionJsonValue };
}

export async function executeMemoryModelCommand(
    mailing: MailingService,
    argv: readonly string[],
    context: CliModelCommandInvocationContext,
): Promise<CliCommandResult> {
    if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h")
        return { kind: "text", text: modelUsage };
    if (context.ctxId === undefined) throw new Error("Memory requires an authenticated MCP Context");
    const identity = {
        instance: context.instance,
        workspace: context.workspace,
        ctxId: context.ctxId,
    };
    const command = argv[0] ?? "status";
    switch (command) {
        case "init":
        case "inherit":
            if (argv.length !== 2) throw new Error(modelUsage);
            return json(command === "init"
                ? await mailing.init(identity, argv[1]!)
                : await mailing.inherit(identity, argv[1]!));
        case "release":
            if (argv.length !== 1) throw new Error(modelUsage);
            return json(await mailing.release(identity));
        case "list":
            if (argv.length !== 1) throw new Error(modelUsage);
            return json(await mailing.list(identity));
        case "status":
            if (argv.length > 1) throw new Error(modelUsage);
            return json(await mailing.status(identity));
        default:
            throw new Error(modelUsage);
    }
}

export async function executeMemoryNativeCommand(
    mailing: MailingService,
    argv: readonly string[],
    context: CliNativeCommandInvocationContext,
): Promise<CliCommandResult> {
    if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help")
        return { kind: "text", text: nativeUsage };
    if (!context.localOwner) throw new Error("Memory administration requires the local Control owner");
    const [command, instance, workspace, ctxId, name] = argv;
    if (!instance || !workspace) throw new Error(nativeUsage);
    if (command === "list" && argv.length === 3)
        return json(await mailing.list({ instance, workspace }));
    if (!ctxId) throw new Error(nativeUsage);
    const identity = { instance, workspace, ctxId };
    switch (command) {
        case "init":
        case "inherit":
            if (argv.length !== 5 || !name) throw new Error(nativeUsage);
            return json(command === "init"
                ? await mailing.init(identity, name)
                : await mailing.inherit(identity, name));
        case "status":
            if (argv.length !== 4) throw new Error(nativeUsage);
            return json(await mailing.status(identity));
        case "release":
            if (argv.length !== 4) throw new Error(nativeUsage);
            return json(await mailing.release(identity));
        default:
            throw new Error(nativeUsage);
    }
}
