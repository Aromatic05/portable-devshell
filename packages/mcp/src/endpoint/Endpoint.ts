import type {
    ControlMcpContextMode,
    JsonValue,
    ToolDefinition,
} from "@portable-devshell/shared";

import type { McpAuthConfig } from "../auth/Config.js";
import type { ContextRegistryPort } from "@portable-devshell/shared";
import type { ContextEnvironmentPort, ContextCleanupPort } from "../context/Port.js";
import { createMcpContextSelector } from "../context/Selector.js";
import type { McpInstanceGateway } from "../instance/Gateway.js";
import type { McpTool } from "./tool/Schema.js";
import { McpExtensionRegistry } from "./extension/Registry.js";
import type { WorkspaceAppLeaseStore } from "../workspace/app/Lease.js";
import type { WorkspaceAppPresenceStore } from "../workspace/app/Presence.js";
import type { WorkspaceActionStore } from "../workspace/ActionStore.js";
import { McpEndpointCatalog } from "./tool/Catalog.js";
import type { McpToolProvenanceRecorder } from "./tool/Provenance.js";
import { McpEndpointDispatch } from "./dispatch/Dispatch.js";
import type {
    McpEndpointCallContext,
    McpEndpointWorkerPort,
} from "./call/Port.js";
import type { McpEndpointResult } from "./call/Boundary.js";

export type {
    McpEndpointCallContext,
    McpEndpointWorkerPort,
} from "./call/Port.js";
export type { McpEndpointEnvironmentHandshake } from "../instance/Gateway.js";

export interface McpEndpointWorkerOptions {
    auth?: McpAuthConfig;
    contextRegistry: ContextRegistryPort;
    environmentService: ContextEnvironmentPort;
    cleanup: ContextCleanupPort;
    contextMode?: ControlMcpContextMode;
    extensions?: McpExtensionRegistry;
    gateway?: McpInstanceGateway;
    instanceName: string;
    readyWaitMs?: number;
    toolProvenance?: McpToolProvenanceRecorder;
    worker: McpEndpointWorkerPort;
    workspaceAppEnabled?: boolean;
    workspaceAppLeases?: WorkspaceAppLeaseStore;
    workspaceAppPresence?: WorkspaceAppPresenceStore;
    workspaceActionStore?: WorkspaceActionStore;
    workspaceLiveBaseUrl?: string;
}

export class McpEndpointWorker {
    readonly #catalog: McpEndpointCatalog;
    readonly #dispatch: McpEndpointDispatch;
    readonly #extensions: McpExtensionRegistry;
    readonly #instanceName: string;
    readonly #worker: McpEndpointWorkerPort;

    constructor(options: McpEndpointWorkerOptions) {
        const contextSelector = createMcpContextSelector(
            options.contextMode ?? "explicit",
        );
        this.#extensions = options.extensions ?? new McpExtensionRegistry();
        this.#catalog = new McpEndpointCatalog({
            auth: options.auth,
            contextSelector,
            gateway: options.gateway,
            instanceName: options.instanceName,
            presentationResourceUri:
                this.#extensions.environmentPresentation()?.resourceUri,
            worker: options.worker,
            workspaceAppEnabled: options.workspaceAppEnabled,
        });
        this.#dispatch = new McpEndpointDispatch({
            catalog: this.#catalog,
            environmentService: options.environmentService,
            cleanup: options.cleanup,
            contextRegistry: options.contextRegistry,
            contextSelector,
            gateway: options.gateway,
            instanceName: options.instanceName,
            readyWaitMs: options.readyWaitMs,
            toolProvenance: options.toolProvenance,
            worker: options.worker,
            workspaceAppLeases: options.workspaceAppLeases,
            workspaceAppPresence: options.workspaceAppPresence,
            workspaceActionStore: options.workspaceActionStore,
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

    hasAppResources(): boolean {
        return this.#extensions.hasAppResources();
    }

    listResources() {
        return this.#extensions.listResources();
    }

    async readResource(uri: string) {
        return await this.#extensions.readResource(uri);
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

    catalogSnapshot() {
        return this.#catalog.snapshot();
    }
}

export { McpNativeToolResult, type McpEndpointResult } from "./call/Boundary.js";
