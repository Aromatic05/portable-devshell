import {
    ToolCallBoundarySequence,
    type ToolCallBoundaryContext,
    type ToolCallBoundaryLease,
    type ToolCallReview,
    type ToolCallRewrite,
} from "@portable-devshell/core";
import {
    review,
    rewrite,
    type ToolCallExtensionDeclaration,
    type ToolCallReviewBinding,
    type ToolCallReviewContext,
    type ToolCallReviewInvocation,
    type ToolCallRewriteBinding,
    type ToolCallRewriteInvocation,
} from "@portable-devshell/extension/toolcall";

import type { ExtensionHost } from "../Host.js";
import { ToolCallSecretRewrite } from "./interface/index.js";

export class ToolCallExtensionBinding {
    readonly #secret: ToolCallSecretRewrite;
    readonly #extensions: Pick<
        ExtensionHost,
        "acquireRegistration" | "listDeclarations"
    >;

    constructor(
        extensions: Pick<
            ExtensionHost,
            "acquireRegistration" | "listDeclarations"
        >,
        secret: ToolCallSecretRewrite = new ToolCallSecretRewrite(),
    ) {
        this.#secret = secret;
        this.#extensions = extensions;
    }

    async acquire(
        context: ToolCallBoundaryContext,
    ): Promise<ToolCallBoundaryLease> {
        const releases: Array<() => void> = [];
        try {
            const reviews = await this.#acquireReviews(releases);
            const rewrites = await this.#acquireRewrites(releases, context);
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
        for (const { id } of orderedHooks(
            this.#extensions.listDeclarations(review.id),
        )) {
            const { extensionId, lease, registration } =
                await this.#extensions.acquireRegistration(review.id, id);
            releases.push(() => lease.release());
            const binding = registration.binding as ToolCallReviewBinding;
            bindings.push(async (input) => {
                const invocation = input as ToolCallReviewInvocation;
                return await binding(
                    invocation,
                    unsupportedReviewContext(extensionId),
                );
            });
        }
        return bindings;
    }

    async #acquireRewrites(
        releases: Array<() => void>,
        context: ToolCallBoundaryContext,
    ): Promise<readonly ToolCallRewrite[]> {
        const bindings: ToolCallRewrite[] = [];
        for (const { id } of orderedHooks(
            this.#extensions.listDeclarations(rewrite.id),
        )) {
            const { extensionId, lease, registration } =
                await this.#extensions.acquireRegistration(rewrite.id, id);
            releases.push(() => lease.release());
            const binding = registration.binding as ToolCallRewriteBinding;
            const secret = this.#secret.scope(extensionId, context.instance);
            bindings.push(async (input) => {
                const invocation = input as ToolCallRewriteInvocation;
                return await binding(invocation, secret.context(invocation));
            });
        }
        return bindings;
    }
}

function orderedHooks(
    declarations: ReturnType<ExtensionHost["listDeclarations"]>,
): ReturnType<ExtensionHost["listDeclarations"]> {
    return [...declarations].sort((left, right) => {
        const leftHook = (left.declaration as ToolCallExtensionDeclaration).hook;
        const rightHook = (right.declaration as ToolCallExtensionDeclaration).hook;
        return (
            leftHook.localeCompare(rightHook) ||
            left.id.localeCompare(right.id) ||
            left.extensionId.localeCompare(right.extensionId)
        );
    });
}

function unsupportedReviewContext(
    extensionId: string | undefined,
): ToolCallReviewContext {
    return Object.freeze({
        requestInterface: async (operation: string): Promise<never> => {
            throw new TypeError(
                `Unsupported ToolCall review interface operation for Extension ${extensionId ?? "unknown"}: ${operation}.`,
            );
        },
    });
}
