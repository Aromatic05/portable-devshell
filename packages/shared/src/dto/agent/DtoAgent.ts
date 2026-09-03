import type { JsonValue } from "../../type/TypeJsonValue.js";
import type { ToolDefinition } from "../tool/DtoToolDefinition.js";

export type AgentRuntimeState = "starting" | "running" | "stopping" | "stopped";

export interface AgentTarget {
    instance: string;
    workspace: string;
}

export interface AgentRecord {
    agentId: string;
    provider: string;
    providerVersion: string;
    state: AgentRuntimeState;
    target: AgentTarget;
}

export interface AgentStartInput {
    provider?: string;
    target: string;
}

export interface AgentMessageInput {
    agentId: string;
    message: string;
}

export interface AgentToolSessionOpenInput {
    instance: string;
    workspace: string;
}

export interface AgentToolSessionRecord {
    sessionId: string;
    target: AgentTarget;
}

export interface AgentToolSessionCallInput {
    input: JsonValue;
    operationId: string;
    sessionId: string;
    toolName: string;
}

export interface AgentToolSessionToolsResult {
    tools: ToolDefinition[];
}
