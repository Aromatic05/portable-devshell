import { createHash } from 'node:crypto';
import type { ContextTransport, JsonValue } from '@portable-devshell/shared';
import { readMcpContextInput } from '../protocol/Public.js';
import type { McpEndpointCallContext, McpEndpointResult, McpEndpointDispatch } from '../protocol/Api.js';
import { McpNativeToolResult } from '../protocol/Public.js';
import { deliverMcpAppReentry } from './Reentry.js';
import type { McpAppActionOperation } from './model/Contract.js';
import type { McpAppActionReceipt, McpAppActionStore } from './ActionStore.js';
import type { createMcpAppViewModel } from './ViewModel.js';
import { mcpAppToolCallWidgetPayload, mcpAppWidgetPayloadKey } from './WidgetPayload.js';

/** Owns one Instance's MCP App action receipts, reentry and result presentation. */
export class McpAppCall {
    readonly #actions: McpAppActionStore;
    readonly #contexts: Pick<ContextTransport, 'resolve'>;
    readonly #instance: string;
    readonly #dispatch: Pick<McpEndpointDispatch, 'callTool'>;
    readonly #view?: ReturnType<typeof createMcpAppViewModel>;
    readonly #ownsPresentation?: (toolName: string) => boolean;
    readonly #toolCallResourceUriForTool?: (toolName: string) => string | undefined;
    readonly #bootstrap?: (result: JsonValue, request: McpEndpointCallContext) => Promise<{
        ctxId: string; token: string; liveBaseUrl?: string;
    } | undefined>;
    readonly #inflight = new Map<string, Promise<McpEndpointResult>>();

    constructor(options: {
        actions: McpAppActionStore;
        context: Pick<ContextTransport, 'resolve'>;
        dispatch: Pick<McpEndpointDispatch, 'callTool'>;
        instance: string;
        view?: ReturnType<typeof createMcpAppViewModel>;
        ownsPresentation?: (toolName: string) => boolean;
        toolCallResourceUriForTool?: (toolName: string) => string | undefined;
        bootstrap?: (result: JsonValue, request: McpEndpointCallContext) => Promise<{
            ctxId: string; token: string; liveBaseUrl?: string;
        } | undefined>;
    }) {
        this.#actions = options.actions;
        this.#contexts = options.context;
        this.#dispatch = options.dispatch;
        this.#instance = options.instance;
        this.#view = options.view;
        this.#ownsPresentation = options.ownsPresentation;
        this.#toolCallResourceUriForTool = options.toolCallResourceUriForTool;
        this.#bootstrap = options.bootstrap;
    }

    async call(toolName: string, input: JsonValue, request: McpEndpointCallContext,
        signal?: AbortSignal): Promise<McpEndpointResult | undefined> {
        if (toolName === 'mcpapp_action') return await this.#callAction(input, request, signal);
        if (toolName !== 'mcpapp_reentry') return undefined;
        if (this.#view === undefined) throw new Error('MCP App recovery is unavailable.');
        return await deliverMcpAppReentry({
            actions: this.#actions,
            context: this.#contexts,
            dispatch: this.#dispatch,
            instance: this.#instance,
            view: this.#view,
        }, input, request, signal);
    }

    async present(toolName: string, result: McpEndpointResult,
        request: McpEndpointCallContext, input?: JsonValue): Promise<McpEndpointResult> {
        // Presentation metadata only; the audited ToolCall has already passed
        // through the Instance pipeline. Never add a second execution path.
        const native = result instanceof McpNativeToolResult;
        const owned = this.#ownsPresentation?.(toolName) !== false;
        const output = native ? result.structuredContent : result;
        const widgetUri = owned && !toolName.startsWith("mcpapp_")
            ? this.#toolCallResourceUriForTool?.(toolName) : undefined;
        const presented = toolName.startsWith("mcpapp_") ? result : new McpNativeToolResult({
            ...(native
                ? { content: result.content, isError: result.isError } : { content: [] }),
            _meta: {
                ...(native ? result._meta : {}),
                "portable-devshell/toolcall": { name: toolName },
                ...(widgetUri === undefined ? {} : {
                    [mcpAppWidgetPayloadKey]: mcpAppToolCallWidgetPayload(
                        toolName, input, output, native && result.isError,
                    ),
                    "openai/outputTemplate": widgetUri,
                }),
            },
            structuredContent: output,
        });
        // Ordinary results are immutable, self-contained Inline widgets. Only
        // explicit Workspace bootstrap tools need an authenticated Live Lease.
        if ((toolName !== "environ_info" && toolName !== "mcpapp_open") ||
            this.#bootstrap === undefined ||
            this.#ownsPresentation?.(toolName) === false ||
            (presented instanceof McpNativeToolResult && presented.isError)) return presented;
        const structured = presented instanceof McpNativeToolResult ? presented.structuredContent : presented;
        let capability: { ctxId: string; token: string; liveBaseUrl?: string } | undefined;
        try {
            capability = await this.#bootstrap(structured, request);
        } catch (error) {
            // Do not fail a completed ToolCall because Live presentation failed.
            console.warn("MCP App Live bootstrap unavailable:", error);
            return presented;
        }
        if (capability === undefined) return presented;
        return new McpNativeToolResult({
            ...(presented instanceof McpNativeToolResult
                ? { content: presented.content, isError: presented.isError } : { content: [] }),
            _meta: {
                ...(presented instanceof McpNativeToolResult ? presented._meta : {}),
                "portable-devshell/mcpapp": capability,
            },
            structuredContent: toolName === "mcpapp_open" ? { status: "ready" } : structured,
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
        const allowed = ["approve", "deny",
            "goal-pause", "goal-resume", "goal-retry", "goal-stop"];
        if (typeof itemId !== "string" || !itemId || typeof actionId !== "string" ||
            !allowed.includes(actionId) || typeof requestId !== "string" ||
            requestId.length < 16 || requestId.length > 128 ||
            (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)))
            throw new Error("Invalid MCP App action request.");
        const context = await this.#contexts.resolve({ ctxId, principal: requestContext.principal, touch: false });
        if (context.status !== "active" || !context.environments.some((entry) => entry.instance === this.#instance))
            throw new Error("MCP App Context is unavailable.");
        const key = createHash("sha256")
            .update(JSON.stringify([this.#instance, ctxId, requestId]))
            .digest("hex");
        const inflight = this.#inflight.get(key);
        if (inflight) return await inflight;
        const operation: McpAppActionOperation = actionId === "approve" || actionId === "deny"
            ? `approval-${actionId}` : actionId as McpAppActionOperation;
        const execute = (async (): Promise<McpEndpointResult> => {
            const store = this.#actions;
            const resolved = {
                actionId: key,
                itemId,
                instance: this.#instance,
                operation,
                targetId: itemId,
                ...(expectedRevision === undefined ? {} : { revision: Number(expectedRevision) }),
            };
            const prepared = await store.prepareOnce(ctxId, this.#instance, resolved);
            if (!prepared.created) {
                const stored = prepared.receipt;
                if (stored.ctxId !== ctxId || stored.instance !== this.#instance ||
                    JSON.stringify(stored.resolved) !== JSON.stringify(resolved))
                    throw new Error("MCP App action receipt conflicts with another request.");
                if (stored.status === "applied") return {
                    status: "applied", itemId: stored.execution?.itemId ?? itemId,
                    actionId: stored.execution?.actionId ?? actionId,
                };
                // A prepared receipt surviving process restart is uncertain.
                // The Instance state is authoritative; never blindly replay it.
                return { status: "stale", itemId, actionId };
            }
            let execution: McpAppActionReceipt["execution"] | undefined;
            let actualResult: JsonValue | undefined;
            let executedCtxId: string | undefined;
            try {
                const result = await this.#dispatch.callTool("mcpapp_action", input, requestContext, signal,
                    (callId, value, rawResult) => {
                        const payload = typeof value.payload === "object" && value.payload !== null &&
                            !Array.isArray(value.payload) ? value.payload : {};
                        execution = {
                            callId, instance: value.context.instance, toolName: value.toolName,
                            ...(typeof payload.itemId === "string" ? { itemId: payload.itemId } : {}),
                            ...(typeof payload.actionId === "string" ? { actionId: payload.actionId } : {}),
                        };
                        executedCtxId = value.context.ctxId;
                        actualResult = rawResult;
                    });
                if (result instanceof McpNativeToolResult && result.isError)
                    throw new Error("MCP App action failed.");
                const actual = typeof actualResult === "object" && actualResult !== null &&
                    !Array.isArray(actualResult) ? actualResult : {};
                const executedAction = execution?.actionId;
                const executedItem = execution?.itemId;
                if (execution?.instance !== this.#instance || execution.toolName !== "mcpapp_action" ||
                    executedCtxId !== ctxId || typeof executedAction !== "string" ||
                    !allowed.includes(executedAction) || typeof executedItem !== "string" ||
                    actual.status !== "applied" || actual.actionId !== executedAction || actual.itemId !== executedItem) {
                    // Synthetic results, rewritten targets and stale actions must
                    // never generate a Reentry based on the original UI intent.
                    await store.conflict(key, execution);
                    return result;
                }
                await store.apply(key, executedAction === "goal-resume" || executedAction === "goal-retry"
                    ? { kind: "reentry", intent: executedAction, sourceId: executedItem, id: key }
                    : undefined, execution);
                return result;
            } catch (error) {
                await store.conflict(key, execution).catch(() => undefined);
                throw error;
            }
        })();
        this.#inflight.set(key, execute);
        try { return await execute; }
        finally {
            if (this.#inflight.get(key) === execute) this.#inflight.delete(key);
        }
    }

}
