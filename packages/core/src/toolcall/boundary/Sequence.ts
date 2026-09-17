import type { JsonValue } from "@portable-devshell/shared";

import {
    reviewToolCall,
    type ToolCallReview,
    type ToolCallReviewInput,
    type ToolCallReviewResult,
} from "./Review.js";
import {
    rewriteToolCallPayload,
    type ToolCallRewrite,
    type ToolCallRewritePayloadInput,
} from "./Rewrite.js";

export interface ToolCallBoundarySequenceOptions {
    readonly reviews?: readonly ToolCallReview[];
    readonly rewrites?: readonly ToolCallRewrite[];
}

export interface ToolCallBoundaryLease {
    readonly sequence: ToolCallBoundarySequence;
    release(): void;
}

export type ToolCallBoundaryProvider = () =>
    | Promise<ToolCallBoundaryLease>
    | ToolCallBoundaryLease;

export class ToolCallBoundarySequence {
    readonly #reviews: readonly ToolCallReview[];
    readonly #rewrites: readonly ToolCallRewrite[];

    constructor(options: ToolCallBoundarySequenceOptions = {}) {
        this.#reviews = Object.freeze([...(options.reviews ?? [])]);
        this.#rewrites = Object.freeze([...(options.rewrites ?? [])]);
    }

    async review(input: ToolCallReviewInput): Promise<ToolCallReviewResult> {
        return await reviewToolCall(this.#reviews, input);
    }

    async rewrite(input: ToolCallRewritePayloadInput): Promise<JsonValue> {
        return await rewriteToolCallPayload(this.#rewrites, input);
    }
}
