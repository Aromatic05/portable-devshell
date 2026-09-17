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
    type ToolCallRewriteBinding,
} from "@portable-devshell/extension/toolcall";

import type { ExtensionHost } from "../Host.js";

export class ToolCallExtensionBinding {
    readonly #extensions: Pick<
        ExtensionHost,
        "acquireRegistration" | "listDeclarations"
    >;

    constructor(
        extensions: Pick<
            ExtensionHost,
            "acquireRegistration" | "listDeclarations"
        >,
    ) {
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
            const { lease, registration } =
                await this.#extensions.acquireRegistration(review.id, id);
            releases.push(() => lease.release());
            bindings.push(registration.binding as ToolCallReviewBinding);
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
