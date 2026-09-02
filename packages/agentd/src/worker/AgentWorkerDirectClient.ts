import {
    WorkerDirectClient,
    type WorkerDirectClientOptions
} from "@portable-devshell/core";
import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

import type {
    AgentWorkerClient,
    AgentWorkerToolCallOptions
} from "../provider/AgentProvider.js";
import type { AgentWorkerTarget } from "../target/AgentWorkerTarget.js";

export interface AgentWorkerDirectClientOptions {
    agentId: string;
    directClient: AgentWorkerDirectTransport;
    target: AgentWorkerTarget;
}

export type AgentWorkerDirectTransport = Pick<
    WorkerDirectClient,
    "callTool" | "close" | "listTools" | "prepareWorkspace"
>;

/**
 * Agent-facing adapter over the non-persisting WorkerDirectClient.
 *
 * The provider owns the transcript/tool history. This adapter only binds one
 * Agent identity and workspace to Worker protocol calls.
 */
export class AgentWorkerDirectClient implements AgentWorkerClient {
    readonly #agentId: string;
    readonly #directClient: AgentWorkerDirectTransport;
    readonly target: AgentWorkerTarget;
    #prepared = false;

    constructor(options: AgentWorkerDirectClientOptions) {
        this.#agentId = options.agentId;
        this.#directClient = options.directClient;
        this.target = options.target;
    }

    static create(
        target: AgentWorkerTarget,
        agentId: string,
        options: Omit<WorkerDirectClientOptions, "instanceName">
    ): AgentWorkerDirectClient {
        return new AgentWorkerDirectClient({
            agentId,
            directClient: new WorkerDirectClient({
                ...options,
                clientName: options.clientName ?? "portable-devshell-agentd",
                instanceName: target.instance
            }),
            target
        });
    }

    async listTools(): Promise<readonly ToolDefinition[]> {
        await this.#prepare();
        return await this.#directClient.listTools();
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        options: AgentWorkerToolCallOptions
    ): Promise<JsonValue> {
        await this.#prepare();
        return await this.#directClient.callTool(
            toolName,
            input,
            {
                ctxId: `agent:${this.#agentId}`,
                requestId: options.operationId,
                source: "agent",
                workspace: this.target.workspace
            },
            options.signal
        );
    }

    async close(): Promise<void> {
        this.#prepared = false;
        this.#directClient.close();
    }

    async #prepare(): Promise<void> {
        if (this.#prepared) {
            return;
        }
        await this.#directClient.prepareWorkspace(this.target.workspace);
        this.#prepared = true;
    }
}
