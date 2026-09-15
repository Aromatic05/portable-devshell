import type { CallToolResult } from "@modelcontextprotocol/server";
import type {
    ControlMcpContextMode,
    JsonValue,
    ToolDefinition,
} from "@portable-devshell/shared";

import type { McpAuthConfig } from "../auth/Config.js";
import { McpContextRegistry } from "../context/registry/Registry.js";
import { createMcpContextSelector } from "../context/Selector.js";
import type { McpInstanceGateway } from "./Port.js";
import type { McpTool } from "./tool/Schema.js";
import type { WorkspaceAppLeaseStore } from "../workspace/app/Lease.js";
import type { WorkspaceAppPresenceStore } from "../workspace/app/Presence.js";
import { McpEndpointCatalog } from "./tool/Catalog.js";
import type { McpToolProvenanceRecorder } from "./domain/worker/Provenance.js";
import {
    McpEndpointDispatch,
    type McpEndpointCallContext,
    type McpEndpointWorkerPort,
} from "./dispatch/Dispatch.js";

export type {
    McpEndpointCallContext,
    McpEndpointEnvironmentHandshake,
    McpEndpointWorkerPort,
} from "./dispatch/Dispatch.js";

export interface McpEndpointWorkerOptions {
    auth?: McpAuthConfig;
    contextRegistry?: McpContextRegistry;
    contextMode?: ControlMcpContextMode;
    gateway?: McpInstanceGateway;
    instanceName: string;
    readyWaitMs?: number;
    toolProvenance?: McpToolProvenanceRecorder;
    worker: McpEndpointWorkerPort;
    workspaceAppEnabled?: boolean;
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
        const contextSelector = createMcpContextSelector(
            options.contextMode ?? "explicit",
        );
        this.#catalog = new McpEndpointCatalog({
            auth: options.auth,
            contextSelector,
            gateway: options.gateway,
            instanceName: options.instanceName,
            worker: options.worker,
            workspaceAppEnabled: options.workspaceAppEnabled,
        });
        this.#dispatch = new McpEndpointDispatch({
            catalog: this.#catalog,
            contextRegistry: options.contextRegistry,
            contextSelector,
            gateway: options.gateway,
            instanceName: options.instanceName,
            readyWaitMs: options.readyWaitMs,
            toolProvenance: options.toolProvenance,
            worker: options.worker,
            workspaceAppLeases: options.workspaceAppLeases,
            workspaceAppPresence: options.workspaceAppPresence,
            workspaceLiveBaseUrl: options.workspaceLiveBaseUrl,
        });
        this.#instanceName = options.instanceName;
        this.#worker = options.worker;
    }

    get instanceName(): string {
        return this.#instanceName;
    }

    assertReady(
        worker: Pick<McpEndpointWorkerPort, "snapshot"> = this.#worker,
        instanceName: string = this.#instanceName,
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

    hasWorkspaceApp(): boolean {
        return this.#catalog.getExposed("workspace_open") !== undefined;
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
    ): Promise<McpEndpointResult> {
        return await this.#dispatch.callTool(
            toolName,
            input,
            requestContext,
            signal,
        );
    }

    async restoreTmuxWaits(): Promise<void> {
        await this.#dispatch.restoreTmuxWaits();
    }

    catalogSnapshot() {
        return this.#catalog.snapshot();
    }
}

export class McpNativeToolResult {
    readonly _meta?: CallToolResult["_meta"];
    readonly content: CallToolResult["content"];
    readonly isError: boolean;
    readonly structuredContent: JsonValue;

    constructor(input: {
        _meta?: CallToolResult["_meta"];
        content: CallToolResult["content"];
        isError?: boolean;
        structuredContent: JsonValue;
    }) {
        this._meta = input._meta;
        this.content = input.content;
        this.isError = input.isError ?? false;
        this.structuredContent = input.structuredContent;
    }
}

export type McpEndpointResult = JsonValue | McpNativeToolResult;
