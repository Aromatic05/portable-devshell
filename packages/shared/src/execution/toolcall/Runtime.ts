import { randomUUID } from "node:crypto";

import { createRemoteError, type RemoteErrorBody } from "../../transport/Error.js";
import { asInstanceName } from "../../types/Instance.js";
import { runtimeErrorCodes } from "../../types/Error.js";
import type { JsonValue } from "../../types/Json.js";
import { snapshotJson } from "../../types/JsonSnapshot.js";
import type {
    ToolCallApi,
    ToolCallExecutor,
    ToolCallHookContributor,
    ToolCallHookRuntime,
    ToolCallHookSequenceApi,
    ToolCallHooks,
    ToolCallPresentedResult,
    ToolCallReviewHook,
    ToolCallReviewInput,
    ToolCallReviewResult,
    ToolCallRewriteHook,
    ToolCallRewriteInput,
    ToolCallRuntime,
    ToolCallTargetResolver,
} from "./Api.js";
import {
    attachToolCallErrorPayload,
    type ToolCallContext,
    type ToolCallHookContext,
    type ToolCallHookKind,
    type ToolCallHookValue,
    type ToolCallPresentation,
} from "./Type.js";

type ToolCallReview = (
    input: ToolCallReviewInput,
) => Promise<ToolCallReviewResult> | ToolCallReviewResult;

type ToolCallRewrite = (
    input: ToolCallRewriteInput,
) => Promise<ToolCallHookValue> | ToolCallHookValue;

interface ToolCallHookLease {
    readonly sequence: ToolCallHookSequenceApi;
    release(): void;
}

type ToolCallHookProvider = (
    context: ToolCallHookContext,
    signal: AbortSignal,
    recording: "caller" | "host",
) => Promise<ToolCallHookLease> | ToolCallHookLease;

class ToolCallHookSequence implements ToolCallHookSequenceApi {
    readonly #reviews: readonly ToolCallReview[];
    readonly #rewrites: readonly ToolCallRewrite[];

    constructor(options: {
        readonly reviews?: readonly ToolCallReview[];
        readonly rewrites?: readonly ToolCallRewrite[];
    } = {}) {
        this.#reviews = options.reviews ?? [];
        this.#rewrites = options.rewrites ?? [];
    }

    async review(input: ToolCallReviewInput): Promise<ToolCallReviewResult> {
        const value = snapshotToolCallValue(input.value);
        for (const review of this.#reviews) {
            const result = await review(Object.freeze({ ...input, value }));
            if (result.decision === "reject") return result;
        }
        return { decision: "continue" };
    }

    async rewrite(input: ToolCallRewriteInput): Promise<ToolCallHookValue> {
        let value = input.value;
        for (const rewrite of this.#rewrites)
            value = await rewrite(Object.freeze({ ...input, value }));
        return value;
    }
}

class ToolCallHookRegistry implements ToolCallHooks {
    readonly #contributors: ToolCallHookContributor[] = [];
    readonly #executes = new Map<string, ToolCallExecutor>();
    readonly #reviews: ToolCallReviewHook[] = [];

    registerExecute(toolName: string, execute: ToolCallExecutor): () => void {
        if (this.#executes.has(toolName))
            throw new Error(`ToolCall execute already registered: ${toolName}`);
        this.#executes.set(toolName, execute);
        return () => {
            if (this.#executes.get(toolName) === execute)
                this.#executes.delete(toolName);
        };
    }

    registerReview(review: ToolCallReviewHook): () => void {
        this.#reviews.push(review);
        return () => {
            const index = this.#reviews.indexOf(review);
            if (index >= 0) this.#reviews.splice(index, 1);
        };
    }

    registerContributor(contributor: ToolCallHookContributor): () => void {
        this.#contributors.push(contributor);
        return () => {
            const index = this.#contributors.indexOf(contributor);
            if (index >= 0) this.#contributors.splice(index, 1);
        };
    }

    provider(): ToolCallHookProvider {
        return async (context, signal, recording) =>
            await this.#acquire(context, Object.freeze({ recording, signal }));
    }

    lookupExecute(toolName: string): ToolCallExecutor | undefined {
        return this.#executes.get(toolName);
    }

    close(): void {
        this.#contributors.length = 0;
        this.#executes.clear();
        this.#reviews.length = 0;
    }

    async #acquire(
        context: ToolCallHookContext,
        runtime: ToolCallHookRuntime,
    ): Promise<ToolCallHookLease> {
        const releases: Array<() => void> = [];
        const reviews = [...this.#reviews];
        const rewrites: ToolCallRewriteHook[] = [];
        try {
            for (const contributor of this.#contributors) {
                const contribution = await contributor(context, runtime);
                releases.push(() => contribution.release());
                if (contribution.reviews !== undefined)
                    reviews.push(...contribution.reviews);
                if (contribution.rewrites !== undefined)
                    rewrites.push(...contribution.rewrites);
            }
        } catch (error) {
            releaseAll(releases);
            throw error;
        }
        return {
            sequence: new ToolCallHookSequence({
                reviews: orderHooks(reviews).map(
                    (entry) => (input) => entry.review(input, runtime),
                ),
                rewrites: orderHooks(rewrites).map(
                    (entry) => (input) => entry.rewrite(input, runtime),
                ),
            }),
            release() {
                releaseAll(releases);
            },
        };
    }
}

class ToolCallPipeline implements ToolCallApi {
    readonly #hooks: ToolCallHookProvider;
    readonly #resolveExecute?: (toolName: string) => ToolCallExecutor | undefined;
    readonly #resolveTarget: ToolCallTargetResolver;

    constructor(options: {
        hooks: ToolCallHookProvider;
        resolveExecute?: (toolName: string) => ToolCallExecutor | undefined;
        resolveTarget: ToolCallTargetResolver;
    }) {
        this.#hooks = options.hooks;
        this.#resolveExecute = options.resolveExecute;
        this.#resolveTarget = options.resolveTarget;
    }

    async call(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        transformResult?: (
            result: JsonValue,
            callId: string,
            presentation?: ToolCallPresentation,
        ) => Promise<JsonValue>,
        invocationInput?: (
            input: JsonValue,
            callId: string,
            finalValue: ToolCallHookValue,
        ) => Promise<JsonValue> | JsonValue,
        onProgress?: (progress: JsonValue) => void,
        recording: "caller" | "host" = "host",
    ): Promise<JsonValue> {
        throwIfToolCallAborted(signal);
        const callId = randomUUID();
        const canonicalInput = snapshotJson(input);
        const canonicalContext = Object.freeze({ ...context });
        const hookSignal = signal ?? new AbortController().signal;
        const hookContext: ToolCallHookContext = Object.freeze({
            ...canonicalContext,
            instance: asInstanceName(instance),
        });
        let hookValue: ToolCallHookValue = {
            context: hookContext,
            kind: "call",
            payload: canonicalInput,
            toolName,
        };
        const hookLease = await this.#hooks(hookContext, hookSignal, recording);
        const hooks = hookLease.sequence;
        try {
            const review = await hooks.review({
                callId,
                direction: "inbound",
                value: hookValue,
            });
            if (review.decision === "reject") {
                const rejectionMessage =
                    review.reason ??
                    `Tool call ${hookValue.toolName} was rejected by review.`;
                const rejectionCause =
                    review.error === undefined
                        ? undefined
                        : createRemoteError({
                              code: review.error.code,
                              ...(review.error.details === undefined
                                  ? {}
                                  : { details: review.error.details }),
                              message: rejectionMessage,
                              retryable: false,
                          });
                throw createRemoteError({
                    code: runtimeErrorCodes.toolCallRejected,
                    ...(rejectionCause === undefined
                        ? {}
                        : { cause: rejectionCause }),
                    details: {
                        ...(review.reason === undefined
                            ? {}
                            : { reason: review.reason }),
                        toolName: hookValue.toolName,
                    },
                    message: rejectionMessage,
                    retryable: false,
                });
            }
            hookValue = await hooks.rewrite({
                callId,
                direction: "inbound",
                value: hookValue,
            });
            if (hookValue.kind !== "call") {
                hookValue = await runOutboundPipeline(hooks, {
                    callId,
                    direction: "outbound",
                    value: hookValue,
                });
                const interpreted = interpretTerminalValue(hookValue, onProgress);
                if (interpreted.error !== undefined) throw interpreted.error;
                return interpreted.result!;
            }
            const target = this.#resolveTarget(hookValue.context.instance);
            const execute = this.#resolveExecute?.(hookValue.toolName);
            return await target.dispatch({
                callId,
                ...(execute === undefined ? {} : { execute }),
                hooks,
                ...(invocationInput === undefined ? {} : { invocationInput }),
                ...(onProgress === undefined ? {} : { onProgress }),
                recording,
                ...(signal === undefined ? {} : { signal }),
                ...(transformResult === undefined ? {} : { transformResult }),
                value: hookValue,
            });
        } finally {
            hookLease.release();
        }
    }
}

export function createToolCallRuntime(options: {
    resolveTarget: ToolCallTargetResolver;
}): ToolCallRuntime {
    const hooks = new ToolCallHookRegistry();
    return {
        api: new ToolCallPipeline({
            hooks: hooks.provider(),
            resolveExecute: (toolName) => hooks.lookupExecute(toolName),
            resolveTarget: options.resolveTarget,
        }),
        hooks,
        close: () => hooks.close(),
    };
}

export function presentToolCallResult(
    result: JsonValue,
    presentation: ToolCallPresentation,
): ToolCallPresentedResult {
    return { presentation, result, type: "presented-tool-call-result" };
}

function snapshotToolCallValue(
    value: Readonly<ToolCallHookValue>,
): Readonly<{
    context: Readonly<ToolCallHookContext>;
    kind: ToolCallHookKind;
    payload: JsonValue;
    toolName: string;
}> {
    return snapshotJson(value as unknown as JsonValue) as unknown as Readonly<{
        context: Readonly<ToolCallHookContext>;
        kind: ToolCallHookKind;
        payload: JsonValue;
        toolName: string;
    }>;
}

async function runOutboundReview(
    hooks: ToolCallHookSequenceApi,
    input: Parameters<ToolCallHookSequenceApi["review"]>[0],
): Promise<void> {
    try {
        await hooks.review(input);
    } catch (error) {
        console.warn(error instanceof Error ? error : new Error(String(error)));
    }
}

async function runOutboundPipeline(
    hooks: ToolCallHookSequenceApi,
    input: Parameters<ToolCallHookSequenceApi["rewrite"]>[0],
): Promise<ToolCallHookValue> {
    const value = await hooks.rewrite(input);
    await runOutboundReview(hooks, { ...input, value });
    return value;
}

function interpretTerminalValue(
    value: ToolCallHookValue,
    onProgress?: (progress: JsonValue) => void,
): { error?: Error; result?: JsonValue } {
    if (value.kind === "error") {
        const body = (value.payload as Record<string, JsonValue>)
            .error as unknown as RemoteErrorBody;
        return {
            error: attachToolCallErrorPayload(
                createErrorFromBody(body),
                value.payload,
            ),
        };
    }
    if (value.kind === "progress") {
        try {
            onProgress?.(value.payload);
        } catch (error) {
            console.warn(error instanceof Error ? error : new Error(String(error)));
        }
    }
    return { result: value.payload };
}

function createErrorFromBody(body: RemoteErrorBody): Error {
    return createRemoteError({
        code: body.code,
        ...(body.cause === undefined
            ? {}
            : { cause: createErrorFromBody(body.cause) }),
        ...(body.details === undefined ? {} : { details: body.details }),
        message: body.message,
        retryable: body.retryable,
    });
}

function throwIfToolCallAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted !== true) return;
    throw createRemoteError({
        code: runtimeErrorCodes.toolCallCancelled,
        cause: signal.reason,
        message: "Tool call was cancelled by the client.",
        retryable: true,
        details: {
            reason:
                typeof signal.reason === "string"
                    ? signal.reason
                    : "client cancelled",
        },
    });
}

function orderHooks<T extends { readonly hook: string; readonly id: string }>(
    hooks: readonly T[],
): T[] {
    return [...hooks].sort(
        (left, right) =>
            left.hook.localeCompare(right.hook) ||
            left.id.localeCompare(right.id) ||
            ((left as { owner?: string }).owner ?? "").localeCompare(
                (right as { owner?: string }).owner ?? "",
            ),
    );
}

function releaseAll(releases: readonly (() => void)[]): void {
    for (const release of [...releases].reverse()) release();
}
