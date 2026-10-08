import { createHash } from "node:crypto";
import type {
    ContextTransport,
    ControlMcpContextMode,
    JsonValue,
    ToolCallApi,
    ToolDefinition,
} from "@portable-devshell/shared";

import type { McpAuthConfig } from "../auth/Config.js";
import { createMcpContextSelector } from "../context/Selector.js";
import { readMcpContextInput } from "../context/Selector.js";
import type { McpAppActionStore } from "../mcpapp/ActionStore.js";
import type { McpAppActionOperation } from "../mcpapp/model/Contract.js";
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
    mcpAppActions?: McpAppActionStore;
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
    readonly #mcpAppActions?: McpAppActionStore;
    readonly #mcpAppInflight = new Map<string, Promise<McpEndpointResult>>();
    readonly #context: Pick<ContextTransport, "resolve">;

    constructor(options: McpEndpointOptions) {
        const contextSelector = createMcpContextSelector(
            options.contextMode ?? "explicit",
        );
        this.#extensions = options.extensions ?? new McpExtensionRegistry();
        this.#mcpAppBootstrap = options.mcpAppBootstrap;
        this.#mcpAppActions = options.mcpAppActions;
        this.#context = options.context;
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
        if (toolName === "mcpapp_action" && this.#mcpAppActions)
            return await this.#callAction(input, requestContext, signal);
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

    async #callAction(
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
    ): Promise<McpEndpointResult> {
        const { ctxId } = readMcpContextInput(input);
        const action = typeof input === "object" && input !== null && !Array.isArray(input)
            ? input : {};
        const { itemId, actionId, requestId, expectedRevision } = action;
        const allowed = ["approve", "deny", "task-pause", "task-resume", "task-cancel",
            "goal-pause", "goal-resume", "goal-retry", "goal-stop"];
        if (typeof itemId !== "string" || !itemId || typeof actionId !== "string" ||
            !allowed.includes(actionId) || typeof requestId !== "string" ||
            requestId.length < 16 || requestId.length > 128 ||
            (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)))
            throw new Error("Invalid MCP App action request.");
        const context = await this.#context.resolve({ ctxId, principal: requestContext.principal, touch: false });
        if (context.status !== "active" || !context.environments.some((entry) => entry.instance === this.#instanceName))
            throw new Error("MCP App Context is unavailable.");
        const key = createHash("sha256")
            .update(JSON.stringify([this.#instanceName, ctxId, requestId]))
            .digest("hex");
        const inflight = this.#mcpAppInflight.get(key);
        if (inflight) return await inflight;
        const operation: McpAppActionOperation = actionId === "approve" || actionId === "deny"
            ? `approval-${actionId}` : actionId as McpAppActionOperation;
        const execute = (async (): Promise<McpEndpointResult> => {
            const store = this.#mcpAppActions!;
            const stored = await store.get(key);
            const resolved = {
                actionId: key,
                itemId,
                instance: this.#instanceName,
                operation,
                targetId: itemId,
                ...(expectedRevision === undefined ? {} : { revision: Number(expectedRevision) }),
            };
            if (stored !== undefined) {
                if (stored.ctxId !== ctxId || stored.instance !== this.#instanceName ||
                    JSON.stringify(stored.resolved) !== JSON.stringify(resolved))
                    throw new Error("MCP App action receipt conflicts with another request.");
                if (stored.status === "applied") return { status: "applied", itemId, actionId };
                // A prepared receipt surviving process restart is uncertain.
                // The Instance state is authoritative; never blindly replay it.
                return { status: "stale", itemId, actionId };
            }
            await store.prepare(ctxId, this.#instanceName, resolved);
            try {
                const result = await this.#dispatch.callTool("mcpapp_action", input, requestContext, signal);
                if (result instanceof McpNativeToolResult && result.isError)
                    throw new Error("MCP App action failed.");
                await store.apply(key);
                return result;
            } catch (error) {
                await store.conflict(key).catch(() => undefined);
                throw error;
            }
        })();
        this.#mcpAppInflight.set(key, execute);
        try { return await execute; }
        finally {
            if (this.#mcpAppInflight.get(key) === execute) this.#mcpAppInflight.delete(key);
        }
    }

    catalogSnapshot() {
        return this.#catalog.snapshot();
    }
}

export { McpNativeToolResult, type McpEndpointResult } from "./call/Boundary.js";
