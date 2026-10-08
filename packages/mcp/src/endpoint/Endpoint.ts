import type {
    ContextTransport,
    ControlMcpContextMode,
    JsonValue,
    ToolCallApi,
    ToolDefinition,
} from "@portable-devshell/shared";

import type { McpAuthConfig } from "../auth/Config.js";
import { createMcpContextSelector } from "../context/Selector.js";
import type { McpTool } from "./tool/Schema.js";
import type { McpToolSource } from "./tool/Source.js";
import { McpExtensionRegistry } from "./extension/Registry.js";
import { McpEndpointCatalog } from "./tool/Catalog.js";
import type { McpToolProvenanceRecorder } from "./tool/Provenance.js";
import { McpEndpointDispatch } from "./dispatch/Dispatch.js";
import type { McpEndpointCallContext } from "./call/Port.js";
import { McpNativeToolResult, type McpEndpointResult } from "./call/Boundary.js";

export type { McpEndpointCallContext } from "./call/Port.js";

export interface McpEndpointOptions {
    auth?: McpAuthConfig;
    context: Pick<ContextTransport, "resolve">;
    contextMode?: ControlMcpContextMode;
    extensions?: McpExtensionRegistry;
    instanceName: string;
    mcpAppBootstrap?: (result: JsonValue, request: McpEndpointCallContext) => Promise<{
        ctxId: string;
        token: string;
        liveBaseUrl?: string;
    } | undefined>;
    toolProvenance?: McpToolProvenanceRecorder;
    toolSource: McpToolSource;
    tools: ToolCallApi;
}

export class McpEndpoint {
    readonly #catalog: McpEndpointCatalog;
    readonly #dispatch: McpEndpointDispatch;
    readonly #extensions: McpExtensionRegistry;
    readonly #instanceName: string;
    readonly #mcpAppBootstrap?: McpEndpointOptions["mcpAppBootstrap"];

    constructor(options: McpEndpointOptions) {
        const contextSelector = createMcpContextSelector(
            options.contextMode ?? "explicit",
        );
        this.#extensions = options.extensions ?? new McpExtensionRegistry();
        this.#mcpAppBootstrap = options.mcpAppBootstrap;
        this.#catalog = new McpEndpointCatalog({
            auth: options.auth,
            bootstrapPresentationResourceUri:
                this.#extensions.environmentPresentation()?.resourceUri,
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
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
    ): Promise<McpEndpointResult> {
        const result = await this.#dispatch.callTool(
            toolName,
            input,
            requestContext,
            signal,
        );
        if (toolName !== "environ_info" || this.#mcpAppBootstrap === undefined ||
            (result instanceof McpNativeToolResult && result.isError)) return result;
        const structured = result instanceof McpNativeToolResult
            ? result.structuredContent : result;
        const capability = await this.#mcpAppBootstrap(structured, requestContext);
        if (capability === undefined) return result;
        return new McpNativeToolResult({
            ...(result instanceof McpNativeToolResult ? {
                content: result.content,
                isError: result.isError,
            } : { content: [] }),
            _meta: {
                ...(result instanceof McpNativeToolResult ? result._meta : {}),
                "portable-devshell/mcpapp": capability,
            },
            structuredContent: structured,
        });
    }

    catalogSnapshot() {
        return this.#catalog.snapshot();
    }
}

export { McpNativeToolResult, type McpEndpointResult } from "./call/Boundary.js";
