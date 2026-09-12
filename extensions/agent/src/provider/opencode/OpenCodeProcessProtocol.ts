import type { ExtensionJsonValue } from "@portable-devshell/extension";

import type { AgentModelToolDefinition } from "../../builtin/provider/AgentToolSession.js";

export interface OpenCodeChildInitMessage {
    command: string;
    id: string;
    localCwd: string;
    modelTools: readonly AgentModelToolDefinition[];
    stateDirectory: string;
    type: "init";
}

export interface OpenCodeChildCommandMessage {
    command: "abort" | "prompt" | "stop" | "wait";
    id: string;
    message?: string;
    type: "command";
}

export interface OpenCodeChildOwnerHeartbeatMessage {
    type: "owner.heartbeat";
}

export interface OpenCodeParentToolResultMessage {
    callId: string;
    error?: string;
    ok: boolean;
    result?: string;
    type: "tool.result";
}

export type OpenCodeParentMessage = OpenCodeChildInitMessage
    | OpenCodeChildCommandMessage
    | OpenCodeChildOwnerHeartbeatMessage
    | OpenCodeParentToolResultMessage;

export interface OpenCodeChildReadyMessage {
    error?: string;
    id: string;
    ok: boolean;
    type: "ready";
}

export interface OpenCodeChildResultMessage {
    error?: string;
    id: string;
    ok: boolean;
    type: "result";
}

export interface OpenCodeChildToolCallMessage {
    callId: string;
    input: ExtensionJsonValue;
    operationId: string;
    toolName: string;
    type: "tool.call";
}

export type OpenCodeChildMessage = OpenCodeChildReadyMessage
    | OpenCodeChildResultMessage
    | OpenCodeChildToolCallMessage;
