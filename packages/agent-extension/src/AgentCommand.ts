import type { AgentHostRecord } from "@portable-devshell/agentd";
import type {
    ExtensionCommandResult,
    ExtensionInvocationContext,
    ExtensionJsonValue
} from "@portable-devshell/extension";

import { AgentExtensionRuntime, AGENT_WEB_RELATIVE_PATH } from "./AgentRuntime.js";

const usage = [
    "Usage:",
    "  devshell agent [--provider <id>] <instance:/workspace>",
    "  devshell agent list",
    "  devshell agent web",
    "  devshell agent show <agentId>",
    "  devshell agent send <agentId> <message>",
    "  devshell agent steer <agentId> <message>",
    "  devshell agent follow-up <agentId> <message>",
    "  devshell agent abort <agentId>",
    "  devshell agent reload <agentId>",
    "  devshell agent stop <agentId>"
].join("\n");

export async function executeAgentCommand(
    runtime: AgentExtensionRuntime,
    argv: readonly string[],
    context: ExtensionInvocationContext
): Promise<ExtensionCommandResult> {
    context.signal.throwIfAborted();
    if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
        if (argv.length > 1) throw usageError("Agent help does not accept extra arguments.");
        return { kind: "text", text: usage };
    }

    switch (argv[0]) {
        case "list":
            expectLength(argv, 1, "agent list");
            return json(runtime.list().map(recordToJson));
        case "web":
            expectLength(argv, 1, "agent web");
            return json({ available: runtime.webUpstream() !== undefined, webPath: AGENT_WEB_RELATIVE_PATH });
        case "show": {
            expectLength(argv, 2, "agent show <agentId>");
            const record = runtime.get(required(argv[1], "agent id is required"));
            return json(record === undefined ? null : withWeb(record));
        }
        case "send":
        case "steer":
        case "follow-up": {
            if (argv.length < 3) throw usageError(`agent ${argv[0]} requires <agentId> <message>`);
            const agentId = required(argv[1], "agent id is required");
            const message = argv.slice(2).join(" ").trim();
            if (message.length === 0) throw usageError("Agent message must not be empty.");
            const input = { agentId, message };
            if (argv[0] === "send") await runtime.prompt(input);
            else if (argv[0] === "steer") await runtime.steer(input);
            else await runtime.followUp(input);
            return json({ accepted: true, agentId, webPath: AGENT_WEB_RELATIVE_PATH });
        }
        case "abort":
        case "reload": {
            expectLength(argv, 2, `agent ${argv[0]} <agentId>`);
            const agentId = required(argv[1], "agent id is required");
            if (argv[0] === "abort") await runtime.abort({ agentId });
            else await runtime.reload({ agentId });
            return json({ accepted: true, agentId, webPath: AGENT_WEB_RELATIVE_PATH });
        }
        case "stop": {
            expectLength(argv, 2, "agent stop <agentId>");
            return json(recordToJson(await runtime.stop({ agentId: required(argv[1], "agent id is required") })));
        }
        default:
            return await start(runtime, argv);
    }
}

async function start(runtime: AgentExtensionRuntime, argv: readonly string[]): Promise<ExtensionCommandResult> {
    let provider: string | undefined;
    let target: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index]!;
        if (value === "--provider") {
            if (provider !== undefined) throw usageError("agent --provider may be supplied only once.");
            provider = required(argv[++index], "agent --provider requires <id>");
            continue;
        }
        if (value.startsWith("-")) throw usageError(`Unknown agent option: ${value}`);
        if (target !== undefined) throw usageError("agent start accepts one <instance:/workspace> target");
        target = value;
    }
    const record = await runtime.start({
        ...(provider === undefined ? {} : { provider }),
        target: required(target, "agent requires <instance:/workspace>")
    });
    return json(withWeb(record));
}

function withWeb(record: AgentHostRecord): ExtensionJsonValue {
    return { ...recordToJson(record) as Record<string, ExtensionJsonValue>, webPath: AGENT_WEB_RELATIVE_PATH };
}

function recordToJson(record: AgentHostRecord): ExtensionJsonValue {
    return {
        agentId: record.agentId,
        provider: record.provider,
        providerVersion: record.providerVersion,
        state: record.state,
        target: {
            instance: record.target.instance,
            workspace: record.target.workspace
        }
    };
}

function json(value: ExtensionJsonValue): ExtensionCommandResult {
    return { kind: "json", value };
}

function expectLength(argv: readonly string[], length: number, usageLine: string): void {
    if (argv.length !== length) throw usageError(`Usage: devshell ${usageLine}`);
}

function required(value: string | undefined, message: string): string {
    if (value !== undefined && value.trim().length > 0) return value.trim();
    throw usageError(message);
}

function usageError(message: string): Error {
    return new TypeError(`${message}\n\n${usage}`);
}
