import type {
    ControlMcpContextMode,
    JsonValue,
    ToolDefinition,
} from "@portable-devshell/shared";

import type { McpAuthConfig } from "../auth/Config.js";
import type { ContextRegistryPort } from "@portable-devshell/shared";
import { createMcpContextSelector } from "../context/Selector.js";
import type { McpInstanceGateway } from "../instance/Gateway.js";
import type { McpTool } from "./tool/Schema.js";
import type { McpToolRegistry } from "./tool/Registry.js";
import { McpExtensionRegistry } from "./extension/Registry.js";
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
    contextMode?: ControlMcpContextMode;
    extensions?: McpExtensionRegistry;
    gateway?: McpInstanceGateway;
    instanceName: string;
    toolProvenance?: McpToolProvenanceRecorder;
    toolRegistry?: McpToolRegistry;
    worker: McpEndpointWorkerPort;
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
            instanceName: options.instanceName,
            instanceRoutingEnabled: options.gateway !== undefined,
            registry: options.toolRegistry,
        });
        this.#dispatch = new McpEndpointDispatch({
            catalog: this.#catalog,
            contextRegistry: options.contextRegistry,
            contextSelector,
            gateway: options.gateway,
            instanceName: options.instanceName,
            toolProvenance: options.toolProvenance,
            worker: options.worker,
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
