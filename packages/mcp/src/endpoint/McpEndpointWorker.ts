import type {
    ControlMcpContextMode,
    JsonValue,
    ToolDefinition,
    ToolPolicy
} from "@portable-devshell/shared";

import type { McpAuthConfig } from "../auth/McpAuthConfig.js";
import { McpContextRegistry } from "../context/McpContextRegistry.js";
import { createMcpContextSelector } from "../context/McpContextSelector.js";
import type { McpInstanceGateway } from "../instance/McpInstanceGateway.js";
import type { McpTool } from "../tool/McpToolSchemaAdapter.js";
import type { WorkspaceAppLeaseStore } from "../workspace/WorkspaceAppLeaseStore.js";
import type { WorkspaceAppPresenceStore } from "../workspace/WorkspaceAppPresenceStore.js";
import { McpEndpointCatalog } from "./McpEndpointCatalog.js";
import type { McpEndpointResult } from "./McpEndpointResult.js";
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
    auth?: McpAuthConfig;
    contextRegistry?: McpContextRegistry;
    contextMode?: ControlMcpContextMode;
    gateway?: McpInstanceGateway;
    instanceName: string;
    policy: ToolPolicy;
    readyWaitMs?: number;
    worker: McpEndpointWorkerPort;
    workspaceAppLeases?: WorkspaceAppLeaseStore;
    workspaceAppPresence?: WorkspaceAppPresenceStore;
    workspaceLiveBaseUrl?: string;
}

export class McpEndpointWorker {
    readonly #catalog: McpEndpointCatalog;
    readonly #dispatch: McpEndpointDispatch;
    readonly #instanceName: string;
    readonly #worker: McpEndpointWorkerPort;

    constructor(options: McpEndpointWorkerOptions) {
        const contextSelector = createMcpContextSelector(options.contextMode ?? "explicit");
        this.#catalog = new McpEndpointCatalog({
            auth: options.auth,
            contextSelector,
            gateway: options.gateway,
            instanceName: options.instanceName,
            policy: options.policy,
            worker: options.worker
        });
        this.#dispatch = new McpEndpointDispatch({
            catalog: this.#catalog,
            contextRegistry: options.contextRegistry,
            contextSelector,
            gateway: options.gateway,
            instanceName: options.instanceName,
            readyWaitMs: options.readyWaitMs,
            worker: options.worker,
            workspaceAppLeases: options.workspaceAppLeases,
            workspaceAppPresence: options.workspaceAppPresence,
            workspaceLiveBaseUrl: options.workspaceLiveBaseUrl
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

    async callTool(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal
    ): Promise<McpEndpointResult> {
        return await this.#dispatch.callTool(
            toolName,
            input,
            requestContext,
            signal
        );
    }

    async restoreTmuxWaits(): Promise<void> {
        await this.#dispatch.restoreTmuxWaits();
    }

    catalogSnapshot() {
        return this.#catalog.snapshot();
    }
}
