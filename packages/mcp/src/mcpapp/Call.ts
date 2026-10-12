import { createHash } from 'node:crypto';
import type { ContextTransport, JsonValue } from '@portable-devshell/shared';
import { readMcpContextInput } from '../protocol/Public.js';
import type { McpAppQuestionStore } from './Question.js';
import type { McpAppPresenceStore } from './app/Presence.js';
import type { McpEndpointCallContext, McpEndpointResult, McpEndpointDispatch } from '../protocol/Api.js';
import { McpNativeToolResult } from '../protocol/Public.js';
import { deliverMcpAppReentry } from './Reentry.js';
import type { McpAppActionOperation } from './model/Contract.js';
import type { McpAppActionReceipt, McpAppActionStore } from './ActionStore.js';
import type { createMcpAppViewModel } from './ViewModel.js';

/** Owns one Instance's MCP App action receipts, reentry and result presentation. */
export class McpAppCall {
    readonly #actions: McpAppActionStore;
    readonly #questions?: McpAppQuestionStore;
    readonly #presence?: McpAppPresenceStore;
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
        questions?: McpAppQuestionStore;
        presence?: McpAppPresenceStore;
        context: Pick<ContextTransport, 'resolve'>;
        dispatch: Pick<McpEndpointDispatch, 'callTool'>;
        instance: string;
        view?: ReturnType<typeof createMcpAppViewModel>;
        bootstrap?: (result: JsonValue, request: McpEndpointCallContext) => Promise<{
            ctxId: string; token: string; liveBaseUrl?: string;
        } | undefined>;
    }) {
        this.#actions = options.actions;
        this.#questions = options.questions;
        this.#presence = options.presence;
        this.#contexts = options.context;
        this.#dispatch = options.dispatch;
        this.#instance = options.instance;
        this.#view = options.view;
        this.#bootstrap = options.bootstrap;
    }

    async call(toolName: string, input: JsonValue, request: McpEndpointCallContext,
        signal?: AbortSignal): Promise<McpEndpointResult | undefined> {
        if (toolName === 'mcpapp_action') return await this.#callAction(input, request, signal);
        if (toolName === 'mcpapp_ask') return await this.#callAsk(input, request, signal);
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
        // Presentation metadata only; the audited ToolCall has already passed
        // through the Instance pipeline. Never add a second execution path.
        const presented = toolName.startsWith("mcpapp_") ? result : new McpNativeToolResult({
            ...(result instanceof McpNativeToolResult
                ? { content: result.content, isError: result.isError } : { content: [] }),
            _meta: {
                ...(result instanceof McpNativeToolResult ? result._meta : {}),
                "portable-devshell/toolcall": { name: toolName },
            },
            structuredContent: result instanceof McpNativeToolResult ? result.structuredContent : result,
        });
        if ((toolName !== "environ_info" && toolName !== "mcpapp_open") || this.#bootstrap === undefined ||
            (presented instanceof McpNativeToolResult && presented.isError)) return presented;
        const structured = presented instanceof McpNativeToolResult ? presented.structuredContent : presented;
        const capability = await this.#bootstrap(structured, request);
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

    async #callAsk(input: JsonValue, request: McpEndpointCallContext,
        signal?: AbortSignal): Promise<McpEndpointResult> {
        if (this.#bootstrap === undefined || this.#questions === undefined || this.#presence === undefined)
            throw new Error("MCP App questions are unavailable.");
        // First run the validated ToolCall through Instance review/execute/audit.
        const result = await this.#dispatch.callTool("mcpapp_ask", input, request, signal);
        if (result instanceof McpNativeToolResult && result.isError) return result;
        const output = result instanceof McpNativeToolResult ? result.structuredContent : result;
        if (!output || typeof output !== "object" || Array.isArray(output) ||
            output.status !== "ready" || typeof output.question !== "string" ||
            !Array.isArray(output.choices) || typeof output.allowText !== "boolean")
            throw new Error("MCP App question ToolCall returned an invalid result.");
        const ctxId = typeof input === "object" && input !== null && !Array.isArray(input) &&
            typeof input.ctxId === "string" ? input.ctxId : undefined;
        const capability = await this.#bootstrap(ctxId === undefined ? output : { ...output, ctxId }, request);
        if (capability === undefined) throw new Error("MCP App requires an active Context. Call environ_info first.");
        if (!this.#presence.isActive(this.#instance, capability.ctxId, 60_000) &&
            !await this.#presence.waitUntilActive(this.#instance, capability.ctxId, 60_000, 5_000))
            throw new Error("MCP App is not active. Present the App with mcpapp_open before asking.");
        const question = await this.#questions!.create(this.#instance, capability.ctxId, {
            question: output.question, choices: output.choices as string[], allowText: output.allowText,
        });
        const answer = await this.#questions!.wait(question.id, signal);
        if (!answer) throw new Error("MCP App question was revoked while waiting.");
        return { status: "answered", questionId: question.id, answer };
    }

    async #callAction(
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
    ): Promise<McpEndpointResult> {
        const { ctxId } = readMcpContextInput(input);
        const action = typeof input === "object" && input !== null && !Array.isArray(input)
            ? input : {};
        const { itemId, actionId, requestId, expectedRevision, input: answer } = action;
        const allowed = ["approve", "deny", "task-pause", "task-resume", "task-cancel",
            "goal-pause", "goal-resume", "goal-retry", "goal-stop",
            "question-answer-text", "question-answer-choice"];
        if (typeof itemId !== "string" || !itemId || typeof actionId !== "string" ||
            !allowed.includes(actionId) || typeof requestId !== "string" ||
            requestId.length < 16 || requestId.length > 128 ||
            (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)) ||
            (actionId.startsWith("question-answer-") && (typeof answer !== "string" || !answer || answer.length > 4_000)))
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
                if (actionId.startsWith("question-answer-")) {
                    if (this.#questions === undefined) throw new Error("MCP App questions are unavailable.");
                    this.#questions.assertAnswer(this.#instance, ctxId, itemId, answer as string);
                }
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
                if (executedAction.startsWith("question-answer-")) {
                    if (executedItem !== itemId || actual.input !== answer) {
                        await store.conflict(key, execution);
                        return { status: "stale", itemId, actionId };
                    }
                    const answered = await this.#questions!.answer(this.#instance, ctxId, itemId, answer as string);
                    await store.apply(key, undefined, execution);
                    return { status: "applied", itemId, actionId,
                        detached: answered.detached, question: answered.question.question, answer };
                }
                await store.apply(key, executedAction === "goal-resume" || executedAction === "goal-retry" || executedAction === "task-resume"
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
