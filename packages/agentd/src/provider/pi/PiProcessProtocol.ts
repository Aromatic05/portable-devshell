import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

export interface PiChildInitMessage {
    agentDir: string;
    entrypoint: string;
    localCwd: string;
    remoteWorkspace: string;
    sessionDir: string;
    tools: readonly ToolDefinition[];
    type: "init";
}

export type PiChildCommandName = "abort" | "followUp" | "prompt" | "steer" | "stop";

export interface PiChildCommandMessage {
    command: PiChildCommandName;
    id: string;
    message?: string;
    type: "command";
}

export interface PiChildToolResultMessage {
    error?: string;
    ok: boolean;
    requestId: string;
    result?: JsonValue;
    type: "tool.result";
}

export type PiParentMessage = PiChildInitMessage | PiChildCommandMessage | PiChildToolResultMessage;

export interface PiChildReadyMessage {
    error?: string;
    ok: boolean;
    type: "ready";
    webUpstream?: string;
}

export interface PiChildCommandResultMessage {
    error?: string;
    id: string;
    ok: boolean;
    type: "command.result";
}

export interface PiChildToolCallMessage {
    input: JsonValue;
    requestId: string;
    toolCallId: string;
    toolName: string;
    type: "tool.call";
}

export interface PiChildToolCancelMessage {
    requestId: string;
    type: "tool.cancel";
}

export type PiChildMessage =
    | PiChildReadyMessage
    | PiChildCommandResultMessage
    | PiChildToolCallMessage
    | PiChildToolCancelMessage;
