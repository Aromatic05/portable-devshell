import { createHash } from 'node:crypto';
import type { ContextTransport, JsonValue } from '@portable-devshell/shared';
import { readMcpContextInput } from '../protocol/Public.js';
import type { McpEndpointCallContext, McpEndpointResult, McpEndpointDispatch } from '../protocol/Api.js';
import { McpNativeToolResult } from '../protocol/Public.js';
import { deliverMcpAppReentry } from './Reentry.js';
import type { McpAppActionOperation } from './model/Contract.js';
import type { McpAppActionStore } from './ActionStore.js';
import type { createMcpAppViewModel } from './ViewModel.js';

/** Owns one Instance's MCP App action receipts, reentry and result presentation. */
export class McpAppCall {
    readonly #actions: McpAppActionStore;
    readonly #contexts: Pick<ContextTransport, 'resolve'>;
    readonly #instance: string;
    readonly #dispatch: Pick<McpEndpointDispatch, 'callTool'>;
    readonly #view?: ReturnType<typeof createMcpAppViewModel>;
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
        bootstrap?: (result: JsonValue, request: McpEndpointCallContext) => Promise<{
            ctxId: string; token: string; liveBaseUrl?: string;
        } | undefined>;
    }) {
        this.#actions = options.actions;
        this.#contexts = options.context;
        this.#dispatch = options.dispatch;
        this.#instance = options.instance;
        this.#view = options.view;
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
        request: McpEndpointCallContext): Promise<McpEndpointResult> {
        if (toolName !== 'environ_info' || this.#bootstrap === undefined ||
            (result instanceof McpNativeToolResult && result.isError)) return result;
        const structured = result instanceof McpNativeToolResult ? result.structuredContent : result;
        const capability = await this.#bootstrap(structured, request);
        if (capability === undefined) return result;
        return new McpNativeToolResult({
            ...(result instanceof McpNativeToolResult
                ? { content: result.content, isError: result.isError } : { content: [] }),
            _meta: {
                ...(result instanceof McpNativeToolResult ? result._meta : {}),
                'portable-devshell/mcpapp': capability,
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
                if (stored.status === "applied") return { status: "applied", itemId, actionId };
                // A prepared receipt surviving process restart is uncertain.
                // The Instance state is authoritative; never blindly replay it.
                return { status: "stale", itemId, actionId };
            }
            try {
                const result = await this.#dispatch.callTool("mcpapp_action", input, requestContext, signal);
                if (result instanceof McpNativeToolResult && result.isError)
                    throw new Error("MCP App action failed.");
                await store.apply(key, actionId === "goal-resume" || actionId === "goal-retry" || actionId === "task-resume"
                    ? { kind: "reentry", intent: actionId, sourceId: itemId, id: key }
                    : undefined);
                return result;
            } catch (error) {
                await store.conflict(key).catch(() => undefined);
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
