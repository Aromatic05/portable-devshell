import type { AgentProviderRuntimePaths } from "../runtime/AgentProviderRuntimePaths.js";
import type { AgentWorkerTarget } from "../target/AgentWorkerTarget.js";

export interface AgentProviderWebContext {
    /** Authenticated shared public route assigned by devshell, for example /agent/. */
    basePath: string;
}

export interface AgentProviderStartContext {
    agentId: string;
    runtime: AgentProviderRuntimePaths;
    target: AgentWorkerTarget;
    web?: AgentProviderWebContext;
}

export interface AgentProviderWebEndpoint {
    /** Loopback/private upstream owned by the provider and proxied by devshell. */
    upstream: URL;
}

export interface AgentProviderHandle {
    readonly closed: Promise<void>;
    readonly web?: AgentProviderWebEndpoint;
    abort?(): Promise<void>;
    followUp?(message: string): Promise<void>;
    prompt(message: string): Promise<void>;
    steer?(message: string): Promise<void>;
    stop(): Promise<void>;
}

/**
 * Agent runtime implementation. Pi is expected to be the first provider, but
 * no Pi-specific types belong in the agentd public contract.
 */
export interface AgentProvider {
    readonly id: string;
    readonly version: string;
    start(context: AgentProviderStartContext): Promise<AgentProviderHandle>;
}
