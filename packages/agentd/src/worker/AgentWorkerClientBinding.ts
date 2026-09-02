import type { WorkerHandle } from "@portable-devshell/core";
import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

import type {
    AgentWorkerClient,
    AgentWorkerToolCallOptions
} from "../provider/AgentProvider.js";
import type { AgentWorkerTarget } from "../target/AgentWorkerTarget.js";

export interface AgentWorkerClientBindingOptions {
    agentId: string;
    handle: AgentWorkerHandle;
    target: AgentWorkerTarget;
}

export type AgentWorkerHandle = Pick<
    WorkerHandle,
    "callTool" | "listTools" | "prepareWorkspace" | "releaseToolSession"
>;

/**
 * Binds one Agent identity and workspace to an existing managed Worker handle.
 * The underlying instance connection is shared and remains owned by Control.
 */
export class AgentWorkerClientBinding implements AgentWorkerClient {
    readonly #handle: AgentWorkerHandle;
    readonly #sessionId: string;
    readonly target: AgentWorkerTarget;
    #prepared = false;

    constructor(options: AgentWorkerClientBindingOptions) {
        this.#handle = options.handle;
        this.#sessionId = `agent:${options.agentId}`;
        this.target = options.target;
    }

    async listTools(): Promise<readonly ToolDefinition[]> {
        await this.#prepare();
        return this.#handle.listTools();
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        options: AgentWorkerToolCallOptions
    ): Promise<JsonValue> {
        await this.#prepare();
        return await this.#handle.callTool(
            toolName,
            input,
            {
                ctxId: this.#sessionId,
                requestId: options.operationId,
                source: "agent",
                workspace: this.target.workspace
            },
            options.signal
        );
    }

    async close(): Promise<void> {
        this.#prepared = false;
        await this.#handle.releaseToolSession(this.#sessionId);
    }

    async #prepare(): Promise<void> {
        if (this.#prepared) {
            return;
        }
        await this.#handle.prepareWorkspace(this.target.workspace);
        this.#prepared = true;
    }
}
