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
import { McpEndpointCatalog, withoutAppMetadata } from "./tool/Catalog.js";
import type { McpToolProvenanceRecorder } from "./tool/Provenance.js";
import { isAppOnlyInteractionTool, McpEndpointDispatch } from "./dispatch/Dispatch.js";
import type { McpEndpointCallContext } from "./call/Port.js";
import { McpNativeToolResult, type McpEndpointResult } from "./call/Boundary.js";
import type { McpModelOutputBudget } from "./call/ModelOutput.js";

export type { McpEndpointCallContext } from "./call/Port.js";

export interface McpEndpointOptions {
    appEnabled?: boolean | (() => boolean);
    auth?: McpAuthConfig;
    context: Pick<ContextTransport, "resolve">;
    contextMode?: ControlMcpContextMode;
    extensions?: McpExtensionRegistry;
    instanceName: string;
    instanceRoutingEnabled?: boolean;
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
    readonly contextMode: ControlMcpContextMode;
    readonly #catalog: McpEndpointCatalog;
    readonly #dispatch: McpEndpointDispatch;
    readonly #extensions: McpExtensionRegistry;
    readonly #appEnabled: () => boolean;
    readonly #instanceName: string;
    readonly #toolAdapter?: ReturnType<NonNullable<McpEndpointOptions['toolAdapter']>>;
    constructor(options: McpEndpointOptions) {
        const contextSelector = createMcpContextSelector(
            options.contextMode ?? "explicit",
        );
        this.contextMode = contextSelector.id;
        const appEnabled = options.appEnabled;
        this.#appEnabled = () => this.contextMode === "openai-session" &&
            (typeof appEnabled === "function" ? appEnabled() : appEnabled !== false);
        this.#extensions = options.extensions ?? new McpExtensionRegistry();
        this.#catalog = new McpEndpointCatalog({
            auth: options.auth,
            appEnabled: this.#appEnabled,
            bootstrapPresentationResourceUri:
                this.#extensions.environmentPresentation()?.resourceUri,
            toolCallPresentationResourceUri:
                this.#extensions.environmentPresentation()?.toolCallResourceUri,
            toolCallPresentationResourceUriForTool:
                this.#extensions.environmentPresentation()?.toolCallResourceUriForTool,
            contextSelector,
            instanceName: options.instanceName,
            instanceRoutingEnabled: options.instanceRoutingEnabled,
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
        return this.#appEnabled() && this.#extensions.hasAppResources();
    }

    listResources() {
        return this.#extensions.listResources(this.#appEnabled());
    }

    async readResource(uri: string) {
        return await this.#extensions.readResource(uri, this.#appEnabled());
    }

    async callTool(
        toolName: string, input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
        onProgress?: (progress: JsonValue) => void,
    ): Promise<McpEndpointResult> {
        const hideContext = this.contextMode !== "explicit" && !isAppOnlyInteractionTool(toolName);
        if (hideContext && this.contextMode !== "stateless") input = withoutContextId(input);
        const adapter = this.#appEnabled() ? this.#toolAdapter : undefined;
        const intercepted = await adapter?.call(toolName, input, requestContext, signal);
        if (intercepted !== undefined) return intercepted;
        const executed = await this.#dispatch.callTool(
            toolName,
            input,
            requestContext,
            signal,
            undefined,
            onProgress,
        );
        const result = !hideContext ? executed : executed instanceof McpNativeToolResult
            ? new McpNativeToolResult({ ...executed, structuredContent: withoutContextId(executed.structuredContent) })
            : withoutContextId(executed);
        if (adapter !== undefined) return await adapter.present(toolName, result, requestContext, input);
        return !this.#appEnabled() && result instanceof McpNativeToolResult
            ? new McpNativeToolResult({ ...result, _meta: withoutAppMetadata(result._meta) })
            : result;
    }

    catalogSnapshot() {
        return this.#catalog.snapshot();
    }
}

function withoutContextId(value: JsonValue): JsonValue {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !("ctxId" in value)) return value;
    const { ctxId: _ctxId, ...visible } = value;
    return visible;
}

export { McpNativeToolResult, type McpEndpointResult } from "./call/Boundary.js";
