import type { ExtensionJsonValue } from "@portable-devshell/extension";

import type { AgentWorkerTarget } from "../worker/AgentWorkerTarget.js";

export interface AgentToolDefinition {
    description: string;
    inputSchema: ExtensionJsonValue;
    name: string;
}

export interface AgentModelToolDefinition {
    description: string;
    inputSchema: ExtensionJsonValue;
    name: string;
}

/**
 * Agent-owned view of one devshell Worker tool session.
 *
 * The concrete session is supplied by the embedding runtime (currently the
 * Agent Extension). The provider layer deliberately does not know how Control acquires or
 * authorizes the underlying Worker connection.
 */
export interface AgentToolSession {
    /** Settles when the host-owned Worker session can no longer be used. */
    readonly closed: Promise<void>;
    readonly target: AgentWorkerTarget;
    /** Agent-owned model-facing projection of the canonical Worker catalog. */
    readonly modelTools: readonly AgentModelToolDefinition[];
    /** Canonical Worker capabilities retained for provider-internal operations. */
    readonly tools: readonly AgentToolDefinition[];
    callTool(
        toolName: string,
        input: ExtensionJsonValue,
        operationId: string,
        signal?: AbortSignal,
        onProgress?: (progress: ExtensionJsonValue) => void
    ): Promise<ExtensionJsonValue>;
    /** Close is required to be idempotent. */
    close(): Promise<void> | void;
}
