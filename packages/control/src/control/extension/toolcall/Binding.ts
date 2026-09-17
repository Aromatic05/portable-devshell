import {
    ToolCallBoundarySequence,
    type ToolCallBoundaryLease,
    type ToolCallReview,
    type ToolCallRewrite,
} from "@portable-devshell/core";
import {
    review,
    rewrite,
    type ToolCallReviewBinding,
    type ToolCallReviewInvocation,
    type ToolCallRewriteBinding,
} from "@portable-devshell/extension/toolcall";

import type { ExtensionHost } from "../Host.js";
import { ToolCallCommentReview } from "./Comment.js";

export class ToolCallExtensionBinding {
    readonly #comment: ToolCallCommentReview;
    readonly #extensions: Pick<
        ExtensionHost,
        "acquireRegistration" | "listDeclarations"
    >;

    constructor(
        extensions: Pick<
            ExtensionHost,
            "acquireRegistration" | "listDeclarations"
        >,
        comment: ToolCallCommentReview = new ToolCallCommentReview(),
    ) {
        this.#comment = comment;
        this.#extensions = extensions;
    }

    async acquire(): Promise<ToolCallBoundaryLease> {
        const releases: Array<() => void> = [];
        try {
            const reviews = await this.#acquireReviews(releases);
            const rewrites = await this.#acquireRewrites(releases);
            let released = false;
            return {
                sequence: new ToolCallBoundarySequence({ reviews, rewrites }),
                release() {
                    if (released) return;
                    released = true;
                    for (const release of [...releases].reverse()) release();
                },
            };
        } catch (error) {
            for (const release of [...releases].reverse()) release();
            throw error;
        }
    }

    async #acquireReviews(
        releases: Array<() => void>,
    ): Promise<readonly ToolCallReview[]> {
        const bindings: ToolCallReview[] = [];
        for (const { id } of this.#extensions.listDeclarations(review.id)) {
            const { extensionId, lease, registration } =
                await this.#extensions.acquireRegistration(review.id, id);
            releases.push(() => lease.release());
            const binding = registration.binding as ToolCallReviewBinding;
            bindings.push(async (input) => {
                const invocation = input as ToolCallReviewInvocation;
                return await binding(
                    invocation,
                    this.#comment.context(extensionId, invocation),
                );
            });
        }
        return bindings;
    }

    async #acquireRewrites(
        releases: Array<() => void>,
    ): Promise<readonly ToolCallRewrite[]> {
        const bindings: ToolCallRewrite[] = [];
        for (const { id } of this.#extensions.listDeclarations(rewrite.id)) {
            const { lease, registration } =
                await this.#extensions.acquireRegistration(rewrite.id, id);
            releases.push(() => lease.release());
            bindings.push(registration.binding as ToolCallRewriteBinding);
        }
        return bindings;
    }
}
