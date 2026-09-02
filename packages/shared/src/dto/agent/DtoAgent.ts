export type AgentRuntimeState = "starting" | "running" | "stopping" | "stopped";

export interface AgentTarget {
    instance: string;
    workspace: string;
}

export interface AgentWebEndpoint {
    basePath: string;
    upstream: string;
}

export interface AgentRecord {
    agentId: string;
    provider: string;
    providerVersion: string;
    slug: string;
    state: AgentRuntimeState;
    target: AgentTarget;
    web?: AgentWebEndpoint;
}

export interface AgentStartInput {
    provider?: string;
    slug?: string;
    target: string;
}

export interface AgentMessageInput {
    agentId: string;
    message: string;
}
