import type { DevshellPiToolDefinition } from "@portable-devshell/pi-extension";
import type { JsonValue } from "@portable-devshell/shared";

import type { AgentWorkerTarget } from "../target/AgentWorkerTarget.js";

/**
 * Agent-owned view of one devshell Worker tool session.
 *
 * The concrete session is supplied by the embedding runtime (currently the
 * Agent Extension). agentd deliberately does not know how Control acquires or
 * authorizes the underlying Worker connection.
 */
export interface AgentToolSession {
    readonly target: AgentWorkerTarget;
    readonly tools: readonly DevshellPiToolDefinition[];
    callTool(
        toolName: string,
        input: JsonValue,
        operationId: string,
        signal?: AbortSignal
    ): Promise<JsonValue>;
    /** Close is required to be idempotent. */
    close(): Promise<void> | void;
}
