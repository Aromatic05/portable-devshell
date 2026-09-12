import type { ExtensionProcessCapability } from "@portable-devshell/extension";

import type { AgentProviderRuntimePaths } from "./AgentProviderRuntimePaths.js";
import type { AgentWorkerTarget } from "../worker/AgentWorkerTarget.js";
import type { AgentToolSession } from "./AgentToolSession.js";

export interface AgentProviderWebContext {
    /** Authenticated shared public route assigned by devshell, for example /agent/. */
    basePath: string;
}

export interface AgentProviderStartContext {
    agentId: string;
    processes: ExtensionProcessCapability;
    runtime: AgentProviderRuntimePaths;
    target: AgentWorkerTarget;
    tools: AgentToolSession;
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
    reload?(): Promise<void>;
    steer?(message: string): Promise<void>;
    stop(): Promise<void>;
    waitForIdle?(): Promise<void>;
}

/** Provider-neutral Agent runtime implementation contract. */
export interface AgentProvider {
    readonly id: string;
    readonly version: string;
    start(context: AgentProviderStartContext): Promise<AgentProviderHandle>;
}
