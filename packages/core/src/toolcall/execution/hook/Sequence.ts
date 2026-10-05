import {
    reviewToolCall,
    type ToolCallHookContext,
    type ToolCallReview,
    type ToolCallReviewInput,
    type ToolCallReviewResult,
} from "./Review.js";
import {
    rewriteToolCallValue,
    type ToolCallRewrite,
    type ToolCallRewriteInput,
} from "./Rewrite.js";

export interface ToolCallHookSequenceOptions {
    readonly reviews?: readonly ToolCallReview[];
    readonly rewrites?: readonly ToolCallRewrite[];
}

export interface ToolCallHookLease {
    readonly sequence: ToolCallHookSequence;
    release(): void;
}

export type ToolCallHookProvider = (
    context: ToolCallHookContext,
    signal: AbortSignal,
    recording: "caller" | "host",
) => Promise<ToolCallHookLease> | ToolCallHookLease;

export class ToolCallHookSequence {
    readonly #reviews: readonly ToolCallReview[];
    readonly #rewrites: readonly ToolCallRewrite[];

    constructor(options: ToolCallHookSequenceOptions = {}) {
        this.#reviews = options.reviews ?? [];
        this.#rewrites = options.rewrites ?? [];
    }

    async review(input: ToolCallReviewInput): Promise<ToolCallReviewResult> {
        return await reviewToolCall(this.#reviews, input);
    }

    async rewrite(input: ToolCallRewriteInput) {
        return await rewriteToolCallValue(this.#rewrites, input);
    }
}
