import type {
    ToolCallReview,
    ToolCallReviewInput,
    ToolCallReviewResult,
    ToolCallRewrite,
    ToolCallRewriteInput,
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

    reviews(): readonly ToolCallReview[] {
        return this.#extensions
            .listDeclarations(review.id)
            .map(({ id }) => async (input) => await this.#review(id, input));
    }

    rewrites(): readonly ToolCallRewrite[] {
        return this.#extensions
            .listDeclarations(rewrite.id)
            .map(({ id }) => async (input) => await this.#rewrite(id, input));
    }

    async #review(
        id: string,
        input: ToolCallReviewInput,
    ): Promise<ToolCallReviewResult> {
        const { lease, registration } = await this.#extensions.acquireRegistration(
            review.id,
            id,
        );
        try {
            const binding = registration.binding as ToolCallReviewBinding;
            return await binding(input);
        } finally {
            lease.release();
        }
    }

    async #rewrite(id: string, input: ToolCallRewriteInput): Promise<string> {
        const { lease, registration } = await this.#extensions.acquireRegistration(
            rewrite.id,
            id,
        );
        try {
            const binding = registration.binding as ToolCallRewriteBinding;
            return await binding(input);
        } finally {
            lease.release();
        }
    }
}
