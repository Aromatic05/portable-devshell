import type { JsonValue } from "@portable-devshell/shared";
import type { AgentToolDefinition, AgentWorkerTarget } from "@portable-devshell/agentd";

export interface PiChildInitMessage {
    entrypoint: string;
    type: "init";
    webBasePath: string;
}

export interface PiChildAgentStartMessage {
    agentId: string;
    id: string;
    localCwd: string;
    target: AgentWorkerTarget;
    tools: readonly AgentToolDefinition[];
    type: "agent.start";
}

export type PiChildCommandName = "abort" | "followUp" | "prompt" | "reload" | "steer" | "stop";

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

export interface PiParentToolResultMessage {
    agentId: string;
    callId: string;
    error?: string;
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

export type PiParentMessage = PiChildInitMessage
    | PiChildAgentStartMessage
    | PiChildAgentCommandMessage
    | PiChildShutdownMessage
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

export type PiChildMessage = PiChildReadyMessage
    | PiChildResultMessage
    | PiChildToolCallMessage
    | PiChildToolCancelMessage
    | PiChildToolCloseMessage;
