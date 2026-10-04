import type { JsonValue, ToolCallContext, ToolCallPresentation } from "@portable-devshell/shared";

import {
    ToolCallHookSequence,
    type ToolCallHookLease,
    type ToolCallHookProvider,
} from "./hook/Sequence.js";
import type {
    ToolCallHookContext,
    ToolCallHookValue,
    ToolCallReviewInput,
    ToolCallReviewResult,
} from "./hook/Review.js";
import type { ToolCallRewriteInput } from "./hook/Rewrite.js";

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
            | Promise<JsonValue | import("./Presentation.js").PresentedToolCallResult>
            | JsonValue
            | import("./Presentation.js").PresentedToolCallResult,
    ): () => void;
    registerReview(review: ToolCallReviewHook): () => void;
}

type ToolCallExecutor = Parameters<ToolCallHooks["registerExecute"]>[1];

/**
 * Cross-domain surface for issuing ToolCalls. Consumers depend on this instead
 * of the concrete pipeline so hook sequencing stays internal.
 */
export interface ToolCallApi {
    call(
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
        recording?: "caller" | "host",
    ): Promise<JsonValue>;
}

/**
 * Owns hook registration, sorting/merging, and lease composition. It builds the
 * internal {@link ToolCallHookSequence} for each call, while consumers only see
 * {@link ToolCallReviewHook}, {@link ToolCallRewriteHook}, and
 * {@link ToolCallHookContributor}.
 */
export class ToolCallHookRegistry implements ToolCallHooks {
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

    /** Register a long-lived review hook and return an unregister function. */
    registerReview(review: ToolCallReviewHook): () => void {
        this.#reviews.push(review);
        return () => {
            const index = this.#reviews.indexOf(review);
            if (index >= 0) this.#reviews.splice(index, 1);
        };
    }

    /** Add a contributor of per-call hooks and return a removal function. */
    registerContributor(contributor: ToolCallHookContributor): () => void {
        this.#contributors.push(contributor);
        return () => {
            const index = this.#contributors.indexOf(contributor);
            if (index >= 0) this.#contributors.splice(index, 1);
        };
    }

    /** Adapt the registry to the hook provider the ToolCall pipeline expects. */
    provider(): ToolCallHookProvider {
        return async (context, signal, recording) =>
            await this.#acquire(context, Object.freeze({ recording, signal }));
    }

    lookupExecute(toolName: string): ToolCallExecutor | undefined {
        return this.#executes.get(toolName);
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
