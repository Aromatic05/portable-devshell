import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type {
    CliCommandResult,
    CliModelCommandInvocationContext
} from "@portable-devshell/extension/cli";

import type { AgentHostRecord } from "./host/AgentHost.js";
import type { AgentProviderManagementRecord } from "./provider/AgentProviderManager.js";
import { AGENT_WEB_RELATIVE_PATH } from "./AgentRuntime.js";

export interface AgentModelRuntimePort {
    abort(value: ExtensionJsonValue | undefined): Promise<void>;
    followUp(value: ExtensionJsonValue | undefined): Promise<void>;
    get(agentId: string): AgentHostRecord | undefined;
    list(): AgentHostRecord[];
    prompt(value: ExtensionJsonValue | undefined): Promise<void>;
    reload(value: ExtensionJsonValue | undefined): Promise<void>;
    start(value: ExtensionJsonValue | undefined): Promise<AgentHostRecord>;
    steer(value: ExtensionJsonValue | undefined): Promise<void>;
    stop(value: ExtensionJsonValue | undefined): Promise<AgentHostRecord>;
    waitForIdle(value: ExtensionJsonValue | undefined): Promise<void>;
}

export interface AgentModelProviderPort {
    list(): Promise<AgentProviderManagementRecord[]>;
}

export const AGENT_MODEL_USAGE = [
    "Usage:",
    "  devshell agent start [--provider <id>]",
    "  devshell agent list",
    "  devshell agent provider list",
    "  devshell agent show <agentId>",
    "  devshell agent send <agentId> <message>",
    "  devshell agent steer <agentId> <message>",
    "  devshell agent follow-up <agentId> <message>",
    "  devshell agent wait <agentId>",
    "  devshell agent abort <agentId>",
    "  devshell agent reload <agentId>",
    "  devshell agent stop <agentId>",
    "",
    "Agent start and lifecycle operations are scoped to the current model instance/workspace."
].join("\n");

export async function executeAgentModelCommand(
    runtime: AgentModelRuntimePort,
    providers: AgentModelProviderPort,
    argv: readonly string[],
    context: CliModelCommandInvocationContext
): Promise<CliCommandResult> {
    context.signal.throwIfAborted();
    if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0] ?? "")) {
        if (argv.length > 1) throw usageError("Agent help does not accept extra arguments.");
        return { kind: "text", text: AGENT_MODEL_USAGE };
    }
    switch (argv[0]) {
        case "start":
            return await start(runtime, argv.slice(1), context);
        case "list":
            expectLength(argv, 1, "agent list");
            return json(runtime.list().filter((record) => inScope(record, context)).map(recordToJson));
        case "provider":
            if (argv.length !== 2 || argv[1] !== "list") throw usageError("Model Agent commands only support `agent provider list`.");
            return json((await providers.list()).map(providerRecordToJson));
        case "show": {
            expectLength(argv, 2, "agent show <agentId>");
            return json(withWeb(requireScoped(runtime, argv[1]!, context)));
        }
        case "send":
        case "steer":
        case "follow-up": {
            if (argv.length < 3) throw usageError(`agent ${argv[0]} requires <agentId> <message>`);
            const agentId = required(argv[1], "agent id is required");
            requireScoped(runtime, agentId, context);
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
            requireScoped(runtime, agentId, context);
            if (argv[0] === "abort") await runtime.abort({ agentId });
            else await runtime.reload({ agentId });
            return json({ accepted: true, agentId, webPath: AGENT_WEB_RELATIVE_PATH });
        }
        case "wait": {
            expectLength(argv, 2, "agent wait <agentId>");
            const agentId = required(argv[1], "agent id is required");
            requireScoped(runtime, agentId, context);
            await runtime.waitForIdle({ agentId });
            return json({ agentId, idle: true, webPath: AGENT_WEB_RELATIVE_PATH });
        }
        case "stop": {
            expectLength(argv, 2, "agent stop <agentId>");
            const agentId = required(argv[1], "agent id is required");
            requireScoped(runtime, agentId, context);
            return json(recordToJson(await runtime.stop({ agentId })));
        }
        case "web":
            throw usageError("agent web is a native human interface and is not exposed as a model command.");
        default:
            throw usageError(`Unknown agent model command: ${argv[0]}`);
    }
}

async function start(
    runtime: AgentModelRuntimePort,
    argv: readonly string[],
    context: CliModelCommandInvocationContext
): Promise<CliCommandResult> {
    let provider: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index]!;
        if (value !== "--provider") throw usageError(`Unknown agent start option: ${value}`);
        if (provider !== undefined) throw usageError("agent --provider may be supplied only once.");
        provider = required(argv[++index], "agent --provider requires <id>");
    }
    const record = await runtime.start({
        ...(provider === undefined ? {} : { provider }),
        target: `${context.instance}:${context.workspace}`
    });
    if (!inScope(record, context)) {
        await runtime.stop({ agentId: record.agentId }).catch(() => undefined);
        throw new Error("Agent runtime returned a target outside the authoritative model Context.");
    }
    return json(withWeb(record));
}

function requireScoped(
    runtime: AgentModelRuntimePort,
    agentId: string,
    context: CliModelCommandInvocationContext
): AgentHostRecord {
    const record = runtime.get(required(agentId, "agent id is required"));
    if (record === undefined || !inScope(record, context)) {
        throw new Error(`Agent ${agentId} is unavailable in the current model Context.`);
    }
    return record;
}

function inScope(record: AgentHostRecord, context: CliModelCommandInvocationContext): boolean {
    return record.target.instance === context.instance && record.target.workspace === context.workspace;
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
        target: { instance: record.target.instance, workspace: record.target.workspace }
    };
}

function providerRecordToJson(record: AgentProviderManagementRecord): ExtensionJsonValue {
    return {
        enabled: record.enabled,
        ...(record.error === undefined ? {} : { error: record.error }),
        id: record.id,
        ...(record.name === undefined ? {} : { name: record.name }),
        state: record.state,
        ...(record.version === undefined ? {} : { version: record.version })
    };
}

function json(value: ExtensionJsonValue): CliCommandResult {
    return { kind: "json", value };
}

function expectLength(argv: readonly string[], length: number, usageLine: string): void {
    if (argv.length !== length) throw usageError(`Usage: devshell ${usageLine}`);
}

function required(value: string | undefined, message: string): string {
    if (value !== undefined && value.trim().length > 0) return value.trim();
    throw usageError(message);
}

function usageError(message: string): TypeError {
    return new TypeError(`${message}\n\n${AGENT_MODEL_USAGE}`);
}
