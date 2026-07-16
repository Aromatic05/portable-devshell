import type {
    JsonValue,
    ToolDefinition,
    ToolPolicy
} from "@portable-devshell/shared";

import { McpContextRegistry } from "../context/McpContextRegistry.js";
import type { McpInstanceGateway } from "../instance/McpInstanceGateway.js";
import type { McpTool } from "../tool/McpToolSchemaAdapter.js";
import { McpEndpointCatalog } from "./McpEndpointCatalog.js";
import {
    McpEndpointDispatch,
    type McpEndpointCallContext,
    type McpEndpointWorkerPort
} from "./McpEndpointDispatch.js";

export type {
    McpEndpointCallContext,
    McpEndpointEnvironmentHandshake,
    McpEndpointWorkerPort
} from "./McpEndpointDispatch.js";

export interface McpEndpointWorkerOptions {
    contextRegistry?: McpContextRegistry;
    gateway?: McpInstanceGateway;
    instanceName: string;
    policy: ToolPolicy;
    worker: McpEndpointWorkerPort;
}

export class McpEndpointWorker {
    readonly #catalog: McpEndpointCatalog;
    readonly #dispatch: McpEndpointDispatch;
    readonly #instanceName: string;
    readonly #worker: McpEndpointWorkerPort;

    constructor(options: McpEndpointWorkerOptions) {
        this.#catalog = new McpEndpointCatalog({
            gateway: options.gateway,
            instanceName: options.instanceName,
            policy: options.policy,
            worker: options.worker
        });
        this.#dispatch = new McpEndpointDispatch({
            catalog: this.#catalog,
            contextRegistry: options.contextRegistry,
            gateway: options.gateway,
            instanceName: options.instanceName,
            worker: options.worker
        });
        this.#instanceName = options.instanceName;
        this.#worker = options.worker;
    }

    get instanceName(): string {
        return this.#instanceName;
    }

    assertReady(
        worker: Pick<McpEndpointWorkerPort, "snapshot"> = this.#worker,
        instanceName: string = this.#instanceName
    ): void {
        this.#dispatch.assertReady(worker, instanceName);
    }

    listTools(): McpTool[] {
        return this.#catalog.listTools();
    }

    getTool(toolName: string): ToolDefinition | undefined {
        return this.#catalog.getTool(toolName);
    }

    hasWorkerSchema(): boolean {
        return this.#catalog.snapshot().hasWorkerSchema;
    }

    async appendSessionOpened(sessionId: string): Promise<void> {
        await this.#worker.appendMcpSessionOpened(sessionId);
    }

    async appendSessionClosed(sessionId: string): Promise<void> {
        await this.#worker.appendMcpSessionClosed(sessionId);
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        return await this.#dispatch.callTool(
            toolName,
            input,
            requestContext,
            signal
        );
    }

    catalogSnapshot() {
        return this.#catalog.snapshot();
    }
}
