import { ToolCallHookSequence, type ToolCallHookLease, type ToolCallHookProvider } from "../execution/hook/Sequence.js";
import type { ToolCallHookContext } from "../execution/hook/Review.js";
import type { ToolCallHooks, ToolCallExecutor, ToolCallHookContributor, ToolCallReviewHook, ToolCallRewriteHook, ToolCallHookRuntime } from "./Api.js";

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
