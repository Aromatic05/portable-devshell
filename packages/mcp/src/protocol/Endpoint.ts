import type {
    ContextTransport,
    ControlMcpContextMode,
    JsonValue,
    ToolCallApi,
    ToolDefinition,
} from "@portable-devshell/shared";

import type { McpAuthConfig } from "../oauth/Config.js";
import { createMcpContextSelector } from "./context/Selector.js";
import type { McpTool } from "./tool/Schema.js";
import type { McpToolSource } from "./tool/Source.js";
import { McpExtensionRegistry } from "./extension/Registry.js";
import { McpEndpointCatalog } from "./tool/Catalog.js";
import type { McpToolProvenanceRecorder } from "./tool/Provenance.js";
import { McpEndpointDispatch } from "./dispatch/Dispatch.js";
import type { McpEndpointCallContext } from "./call/Port.js";
import type { McpEndpointResult } from "./call/Boundary.js";
import type { McpModelOutputBudget } from "./call/ModelOutput.js";

export type { McpEndpointCallContext } from "./call/Port.js";

export interface McpEndpointOptions {
    auth?: McpAuthConfig;
    context: Pick<ContextTransport, "resolve">;
    contextMode?: ControlMcpContextMode;
    extensions?: McpExtensionRegistry;
    instanceName: string;
    modelOutput?: McpModelOutputBudget;
    toolAdapter?: (dispatch: Pick<McpEndpointDispatch, 'callTool'>) => {
        call(name: string, input: JsonValue, request: McpEndpointCallContext,
            signal?: AbortSignal): Promise<McpEndpointResult | undefined>;
        present(name: string, result: McpEndpointResult,
            request: McpEndpointCallContext, input?: JsonValue): Promise<McpEndpointResult>;
    };
    toolProvenance?: McpToolProvenanceRecorder;
    toolSource: McpToolSource;
    tools: ToolCallApi;
}

export class McpEndpoint {
    readonly #catalog: McpEndpointCatalog;
    readonly #dispatch: McpEndpointDispatch;
    readonly #extensions: McpExtensionRegistry;
    readonly #instanceName: string;
    readonly #toolAdapter?: ReturnType<NonNullable<McpEndpointOptions['toolAdapter']>>;
    constructor(options: McpEndpointOptions) {
        const contextSelector = createMcpContextSelector(
            options.contextMode ?? "explicit",
        );
        this.#extensions = options.extensions ?? new McpExtensionRegistry();
        this.#catalog = new McpEndpointCatalog({
            auth: options.auth,
            bootstrapPresentationResourceUri:
                this.#extensions.environmentPresentation()?.resourceUri,
            toolCallPresentationResourceUri:
                this.#extensions.environmentPresentation()?.toolCallResourceUri,
            toolCallPresentationResourceUriForTool:
                this.#extensions.environmentPresentation()?.toolCallResourceUriForTool,
            contextSelector,
            instanceName: options.instanceName,
            source: options.toolSource,
        });
        this.#dispatch = new McpEndpointDispatch({
            catalog: this.#catalog,
            context: options.context,
            contextSelector,
            instanceName: options.instanceName,
            toolProvenance: options.toolProvenance,
            tools: options.tools,
        });
        this.#toolAdapter = options.toolAdapter?.(this.#dispatch);
        this.#instanceName = options.instanceName;
    }

    get instanceName(): string {
        return this.#instanceName;
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
        toolName: string, input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
    ): Promise<McpEndpointResult> {
        const intercepted = await this.#toolAdapter?.call(toolName, input, requestContext, signal);
        if (intercepted !== undefined) return intercepted;
        const result = await this.#dispatch.callTool(toolName, input, requestContext, signal);
        return this.#toolAdapter?.present(toolName, result, requestContext, input) ?? result;
    }

    catalogSnapshot() {
        return this.#catalog.snapshot();
    }
}

export { McpNativeToolResult, type McpEndpointResult } from "./call/Boundary.js";
