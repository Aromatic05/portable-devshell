import {
    createError,
    errorCodes,
    type AgentMessageInput,
    type AgentRecord,
    type AgentStartInput,
    type JsonValue
} from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";

export interface AgentControlPort {
    abort(agentId: string): Promise<void>;
    followUp(input: AgentMessageInput): Promise<void>;
    get(agentId: string): AgentRecord | undefined;
    list(): AgentRecord[];
    prompt(input: AgentMessageInput): Promise<void>;
    start(input: AgentStartInput): Promise<AgentRecord>;
    steer(input: AgentMessageInput): Promise<void>;
    stop(agentId: string): Promise<AgentRecord>;
}

export function createAgentRouteModule(agent: AgentControlPort) {
    return routeModule("agent", {
        list: () => agent.list() as unknown as JsonValue,
        get: (request) => agent.get(readAgentId(request.payload)) as unknown as JsonValue,
        start: async (request) => await agent.start(readStartInput(request.payload)) as unknown as JsonValue,
        prompt: async (request) => {
            await agent.prompt(readMessageInput(request.payload));
            return {};
        },
        steer: async (request) => {
            await agent.steer(readMessageInput(request.payload));
            return {};
        },
        followUp: async (request) => {
            await agent.followUp(readMessageInput(request.payload));
            return {};
        },
        abort: async (request) => {
            await agent.abort(readAgentId(request.payload));
            return {};
        },
        stop: async (request) => await agent.stop(readAgentId(request.payload)) as unknown as JsonValue
    });
}

function readStartInput(value: JsonValue | undefined): AgentStartInput {
    const input = readRecord(value, "agent.start requires an object payload.");
    const target = readString(input.target, "target");
    const provider = readOptionalString(input.provider, "provider");
    const slug = readOptionalString(input.slug, "slug");
    assertOnlyKeys(input, ["provider", "slug", "target"]);
    return {
        target,
        ...(provider === undefined ? {} : { provider }),
        ...(slug === undefined ? {} : { slug })
    };
}

function readMessageInput(value: JsonValue | undefined): AgentMessageInput {
    const input = readRecord(value, "Agent message requires an object payload.");
    assertOnlyKeys(input, ["agentId", "message"]);
    return {
        agentId: readString(input.agentId, "agentId"),
        message: readString(input.message, "message")
    };
}

function readAgentId(value: JsonValue | undefined): string {
    const input = readRecord(value, "Agent request requires an object payload.");
    assertOnlyKeys(input, ["agentId"]);
    return readString(input.agentId, "agentId");
}

function readRecord(value: JsonValue | undefined, message: string): Record<string, JsonValue> {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value;
    }
    throw invalid(message);
}

function readString(value: JsonValue | undefined, field: string): string {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    throw invalid(`${field} must be a non-empty string.`);
}

function readOptionalString(value: JsonValue | undefined, field: string): string | undefined {
    return value === undefined ? undefined : readString(value, field);
}

function assertOnlyKeys(value: Record<string, JsonValue>, allowed: readonly string[]): void {
    const allowedKeys = new Set(allowed);
    if (Object.keys(value).every((key) => allowedKeys.has(key))) return;
    throw invalid(`Agent request accepts only: ${allowed.join(", ")}.`);
}

function invalid(message: string): Error {
    return createError({ code: errorCodes.targetInvalid, message, retryable: false });
}
