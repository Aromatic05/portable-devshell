import type { JsonValue } from "@portable-devshell/shared";
import type {
    AgentModelToolDefinition,
    AgentToolDefinition,
} from "../../../builtin/provider/AgentToolSession.js";
import type { AgentWorkerTarget } from "../../../builtin/worker/AgentWorkerTarget.js";

export interface PiToolErrorPayload {
    code?: string;
    details?: JsonValue;
    message: string;
    retryable?: boolean;
}

export interface PiChildInitMessage {
    agentDirectory: string;
    entrypoint: string;
    managedInstallRoot: string;
    type: "init";
    webBasePath: string;
}

export interface PiChildAgentStartMessage {
    agentId: string;
    id: string;
    localCwd: string;
    modelTools: readonly AgentModelToolDefinition[];
    target: AgentWorkerTarget;
    tools: readonly AgentToolDefinition[];
    type: "agent.start";
}

export type PiChildCommandName =
    "abort" | "followUp" | "prompt" | "reload" | "steer" | "stop" | "wait";

export interface PiChildAgentCommandMessage {
    agentId: string;
    command: PiChildCommandName;
    id: string;
    message?: string;
    type: "agent.command";
}

export interface PiChildShutdownMessage {
    id: string;
    type: "shutdown";
}

export interface PiChildOwnerHeartbeatMessage {
    type: "owner.heartbeat";
}

export interface PiParentToolResultMessage {
    agentId: string;
    callId: string;
    error?: PiToolErrorPayload;
    ok: boolean;
    result?: JsonValue;
    type: "tool.result";
}

export interface PiParentToolProgressMessage {
    agentId: string;
    callId: string;
    progress: JsonValue;
    type: "tool.progress";
}

export type PiParentMessage =
    | PiChildInitMessage
    | PiChildAgentStartMessage
    | PiChildAgentCommandMessage
    | PiChildShutdownMessage
    | PiChildOwnerHeartbeatMessage
    | PiParentToolProgressMessage
    | PiParentToolResultMessage;

export interface PiChildReadyMessage {
    error?: string;
    ok: boolean;
    type: "ready";
    webUpstream?: string;
}

export interface PiChildResultMessage {
    error?: string;
    id: string;
    ok: boolean;
    type: "result";
}

export interface PiChildToolCallMessage {
    agentId: string;
    callId: string;
    input: JsonValue;
    operationId: string;
    toolName: string;
    type: "tool.call";
}

export interface PiChildToolCancelMessage {
    agentId: string;
    callId: string;
    type: "tool.cancel";
}

export interface PiChildToolCloseMessage {
    agentId: string;
    callId: string;
    type: "tool.close";
}

export type PiChildMessage =
    | PiChildReadyMessage
    | PiChildResultMessage
    | PiChildToolCallMessage
    | PiChildToolCancelMessage
    | PiChildToolCloseMessage;

export function encodePiToolError(error: unknown): PiToolErrorPayload {
    const payload: PiToolErrorPayload = {
        message: errorMessage(error),
    };
    if (typeof error !== "object" || error === null) return payload;
    if ("code" in error && typeof error.code === "string")
        payload.code = error.code;
    if ("retryable" in error && typeof error.retryable === "boolean")
        payload.retryable = error.retryable;
    if ("details" in error && isJsonValue(error.details))
        payload.details = error.details;
    return payload;
}

export function decodePiToolError(
    payload: PiToolErrorPayload | undefined,
    fallback: string,
): Error {
    const error = new Error(payload?.message ?? fallback) as Error & {
        code?: string;
        details?: JsonValue;
        retryable?: boolean;
    };
    if (payload?.code !== undefined) error.code = payload.code;
    if (payload?.details !== undefined) error.details = payload.details;
    if (payload?.retryable !== undefined) error.retryable = payload.retryable;
    return error;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
    )
        return error.message;
    return String(error);
}

function isJsonValue(value: unknown): value is JsonValue {
    return isJsonValueInner(value, new Set<object>());
}

function isJsonValueInner(
    value: unknown,
    ancestors: Set<object>,
): value is JsonValue {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
    )
        return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object") return false;
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    try {
        if (Array.isArray(value))
            return value.every((entry) => isJsonValueInner(entry, ancestors));
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return false;
        return Object.values(value).every((entry) =>
            isJsonValueInner(entry, ancestors),
        );
    } finally {
        ancestors.delete(value);
    }
}
