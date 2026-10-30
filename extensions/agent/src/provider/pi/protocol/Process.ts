import type { JsonValue } from "@portable-devshell/shared";
import type {
    AgentModelToolDefinition,
    AgentToolDefinition,
} from "../../../builtin/provider/AgentToolSession.js";
import {
    encodeAgentToolError,
    type AgentToolErrorPayload,
} from "../../../builtin/provider/AgentToolError.js";
import type { AgentWorkerTarget } from "../../../builtin/worker/AgentWorkerTarget.js";

export type PiToolErrorPayload = AgentToolErrorPayload;
export const encodePiToolError = encodeAgentToolError;

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

export function decodePiToolError(
    payload: PiToolErrorPayload | undefined,
    fallback: string,
): Error {
    const error = new Error(payload?.message ?? fallback) as Error & {
        code?: string;
        comment?: string[];
        details?: JsonValue;
        retryable?: boolean;
    };
    if (payload?.code !== undefined) error.code = payload.code;
    if (payload?.comment !== undefined) error.comment = payload.comment;
    if (payload?.details !== undefined) error.details = payload.details;
    if (payload?.retryable !== undefined) error.retryable = payload.retryable;
    return error;
}
