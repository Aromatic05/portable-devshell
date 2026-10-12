import type {
    CliCommandResult,
    CliModelCommandInvocationContext,
    CliNativeCommandInvocationContext,
} from "@portable-devshell/extension/cli";
import type { MailingService } from "./Service.js";

const modelUsage = [
    "Usage:",
    "  devshell mail claim <agent-work-name>",
    "  devshell mail status",
    "  devshell mail release",
].join("\n");

const nativeUsage = [
    "Usage (local Control owner):",
    "  devshell mail scan <instance> <workspace>",
    "  devshell mail claim <instance> <workspace> <ctxId> <agent-work-name>",
    "  devshell mail status <instance> <workspace> <ctxId>",
    "  devshell mail release <instance> <workspace> <ctxId>",
].join("\n");

function json(value: unknown): CliCommandResult {
    return { kind: "json", value: value as import("@portable-devshell/extension").ExtensionJsonValue };
}

export async function executeMailModelCommand(
    mailing: MailingService,
    argv: readonly string[],
    context: CliModelCommandInvocationContext,
): Promise<CliCommandResult> {
    if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help")
        return { kind: "text", text: modelUsage };
    if (context.ctxId === undefined) throw new Error("Mailing requires an authenticated MCP Context");
    const identity = {
        instance: context.instance,
        workspace: context.workspace,
        ctxId: context.ctxId,
    };
    switch (argv[0]) {
        case "claim":
            if (argv.length !== 2) throw new Error("Usage: devshell mail claim <agent-work-name>");
            return json(await mailing.claim(identity, argv[1]!));
        case "release":
            if (argv.length !== 1) throw new Error("Usage: devshell mail release");
            return json(await mailing.release(identity));
        case "status":
            if (argv.length !== 1) throw new Error("Usage: devshell mail status");
            return json(await mailing.status(identity));
        default:
            throw new Error(modelUsage);
    }
}

export async function executeMailNativeCommand(
    mailing: MailingService,
    argv: readonly string[],
    context: CliNativeCommandInvocationContext,
): Promise<CliCommandResult> {
    if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help")
        return { kind: "text", text: nativeUsage };
    if (!context.localOwner) throw new Error("Mailing administration requires the local Control owner");
    const [command, instance, workspace, ctxId, name] = argv;
    if (!instance || !workspace) throw new Error(nativeUsage);
    if (command === "scan" && argv.length === 3) {
        await mailing.scan({ instance, workspace });
        return json({ scanned: true });
    }
    if (!ctxId) throw new Error(nativeUsage);
    const identity = { instance, workspace, ctxId };
    switch (command) {
        case "claim":
            if (argv.length !== 5 || !name) throw new Error(nativeUsage);
            return json(await mailing.claim(identity, name));
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
