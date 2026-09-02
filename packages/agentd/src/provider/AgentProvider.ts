import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

import type { AgentProviderRuntimePaths } from "../runtime/AgentProviderRuntimePaths.js";
import type { AgentWorkerTarget } from "../target/AgentWorkerTarget.js";

export interface AgentWorkerToolCallOptions {
    operationId: string;
    signal?: AbortSignal;
}

/**
 * Direct, non-persisting access to one devshell Worker workspace.
 *
 * Agent providers own their transcript and tool-call history. Implementations
 * of this interface must not introduce a second Agent trajectory store.
 */
export interface AgentWorkerClient {
    readonly target: AgentWorkerTarget;
    listTools(): Promise<readonly ToolDefinition[]>;
    callTool(toolName: string, input: JsonValue, options: AgentWorkerToolCallOptions): Promise<JsonValue>;
    close(): Promise<void>;
}

export interface AgentProviderWebContext {
    /** Authenticated public route assigned by devshell, for example /agent/my-agent/. */
    basePath: string;
}

export interface AgentProviderStartContext {
    agentId: string;
    runtime: AgentProviderRuntimePaths;
    target: AgentWorkerTarget;
    worker: AgentWorkerClient;
    web?: AgentProviderWebContext;
}

export interface AgentProviderWebEndpoint {
    /** Loopback/private upstream owned by the provider and proxied by devshell. */
    upstream: URL;
}

export interface AgentProviderHandle {
    readonly web?: AgentProviderWebEndpoint;
    stop(): Promise<void>;
}

/**
 * Agent runtime implementation. Pi is expected to be the first provider, but
 * no Pi-specific types belong in the agentd public contract.
 */
export interface AgentProvider {
    readonly id: string;
    start(context: AgentProviderStartContext): Promise<AgentProviderHandle>;
}
