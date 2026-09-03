import {
    createError,
    errorCodes,
    toControlErrorBody,
    type AgentMessageInput,
    type AgentRecord,
    type AgentStartInput,
    type AgentToolSessionCallInput,
    type AgentToolSessionOpenInput,
    type AgentToolSessionRecord,
    type AgentToolSessionToolsResult,
    type JsonValue
} from "@portable-devshell/shared";
import type { PrefixRouteContext } from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";

export interface AgentControlPort {
    abort(agentId: string): Promise<void>;
    callToolSession(
        input: AgentToolSessionCallInput,
        connectionId: string,
        signal?: AbortSignal
    ): Promise<JsonValue>;
    closeToolSession(sessionId: string, connectionId: string): Promise<void>;
    connectionClosed?(connectionId: string): Promise<void> | void;
    followUp(input: AgentMessageInput): Promise<void>;
    get(agentId: string): AgentRecord | undefined;
    listToolSessionTools(sessionId: string, connectionId: string): Promise<AgentToolSessionToolsResult>;
    list(): AgentRecord[];
    openToolSession(input: AgentToolSessionOpenInput, connectionId: string): Promise<AgentToolSessionRecord>;
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
        toolSessionOpen: async (request, context) => {
            assertAgentPeer(context);
            return await agent.openToolSession(
                readToolSessionOpenInput(request.payload),
                context.connectionId
            ) as unknown as JsonValue;
        },
        toolSessionList: async (request, context) => {
            assertAgentPeer(context);
            return await agent.listToolSessionTools(
                readToolSessionId(request.payload),
                context.connectionId
            ) as unknown as JsonValue;
        },
        toolSessionCall: async (request, context) => {
            assertAgentPeer(context);
            const controller = new AbortController();
            const stream = await context.openStream(
                { accepted: true },
                { onClose: () => controller.abort() }
            );
            try {
                const result = await agent.callToolSession(
                    readToolSessionCallInput(request.payload),
                    context.connectionId,
                    controller.signal
                );
                await stream.complete(result);
            } catch (error) {
                await stream.cancel(toControlErrorBody(error) ?? {
                    code: errorCodes.targetInvalid,
                    message: error instanceof Error ? error.message : String(error),
                    retryable: false
                });
            }
            return undefined;
        },
        toolSessionClose: async (request, context) => {
            assertAgentPeer(context);
            await agent.closeToolSession(readToolSessionId(request.payload), context.connectionId);
            return {};
        },
        stop: async (request) => await agent.stop(readAgentId(request.payload)) as unknown as JsonValue
    });
}

function assertAgentPeer(context: PrefixRouteContext): void {
    if (context.peer === "agent") return;
    throw createError({
        code: errorCodes.controlClientIdentityInvalid,
        message: "Agent tool sessions require an agent Control peer.",
        retryable: false
    });
}

function readToolSessionOpenInput(value: JsonValue | undefined): AgentToolSessionOpenInput {
    const input = readRecord(value, "agent.toolSessionOpen requires an object payload.");
    assertOnlyKeys(input, ["instance", "workspace"]);
    const instance = readOptionalString(input.instance, "instance");
    return {
        workspace: readString(input.workspace, "workspace"),
        ...(instance === undefined ? {} : { instance })
    };
}

function readToolSessionCallInput(value: JsonValue | undefined): AgentToolSessionCallInput {
    const input = readRecord(value, "agent.toolSessionCall requires an object payload.");
    assertOnlyKeys(input, ["input", "operationId", "sessionId", "toolName"]);
    if (input.input === undefined) throw invalid("input is required.");
    return {
        input: input.input,
        operationId: readString(input.operationId, "operationId"),
        sessionId: readString(input.sessionId, "sessionId"),
        toolName: readString(input.toolName, "toolName")
    };
}

function readToolSessionId(value: JsonValue | undefined): string {
    const input = readRecord(value, "Agent tool session request requires an object payload.");
    assertOnlyKeys(input, ["sessionId"]);
    return readString(input.sessionId, "sessionId");
}

function readStartInput(value: JsonValue | undefined): AgentStartInput {
    const input = readRecord(value, "agent.start requires an object payload.");
    const target = readString(input.target, "target");
    const provider = readOptionalString(input.provider, "provider");
    assertOnlyKeys(input, ["provider", "target"]);
    return {
        target,
        ...(provider === undefined ? {} : { provider })
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
