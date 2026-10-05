import type { JsonValue } from "@portable-devshell/shared";
import type { ToolCallHookContext, ToolCallHookValue, ToolCallReviewInput, ToolCallReviewResult } from "../execution/hook/Review.js";
import type { ToolCallRewriteInput } from "../execution/hook/Rewrite.js";

/**
 * Per-call state shared with every hook. It is frozen once per call so a hook
 * cannot change the recording mode or abort signal observed by later hooks in
 * the same sequence.
 */
export interface ToolCallHookRuntime {
    readonly recording: "caller" | "host";
    readonly signal: AbortSignal;
}

/**
 * A review hook with the ordering metadata the registry sorts on. `hook` is the
 * coarse ordinal (for example "510-approval"); `id` breaks ties.
 */
export interface ToolCallReviewHook {
    readonly hook: string;
    readonly id: string;
    readonly owner?: string;
    readonly review: (
        input: ToolCallReviewInput,
        runtime: ToolCallHookRuntime,
    ) => Promise<ToolCallReviewResult> | ToolCallReviewResult;
}

/** A rewrite hook using the same ordering metadata as a review hook. */
export interface ToolCallRewriteHook {
    readonly hook: string;
    readonly id: string;
    readonly owner?: string;
    readonly rewrite: (
        input: ToolCallRewriteInput,
        runtime: ToolCallHookRuntime,
    ) => Promise<ToolCallHookValue> | ToolCallHookValue;
}

/**
 * Ordered hooks contributed for a single ToolCall together with the lease that
 * owns their per-call acquisitions. The registry releases the lease once the
 * call finishes.
 */
export interface ToolCallHookContribution {
    readonly reviews?: readonly ToolCallReviewHook[];
    readonly rewrites?: readonly ToolCallRewriteHook[];
    release(): void;
}

/**
 * A cross-domain source of per-call hooks. Contributors are asked for their
 * hooks after the call context is known and before review/rewrite begins.
 */
export type ToolCallHookContributor = (
    context: ToolCallHookContext,
    runtime: ToolCallHookRuntime,
) => Promise<ToolCallHookContribution> | ToolCallHookContribution;

export interface ToolCallHooks {
    registerContributor(contributor: ToolCallHookContributor): () => void;
    registerExecute(
        toolName: string,
        execute: (
            callId: string,
            input: JsonValue,
            value: Readonly<ToolCallHookValue>,
            signal?: AbortSignal,
            onProgress?: (progress: JsonValue) => void,
        ) =>
            | Promise<JsonValue | import("../execution/Presentation.js").PresentedToolCallResult>
            | JsonValue
            | import("../execution/Presentation.js").PresentedToolCallResult,
    ): () => void;
    registerReview(review: ToolCallReviewHook): () => void;
}

export type ToolCallExecutor = Parameters<ToolCallHooks["registerExecute"]>[1];

