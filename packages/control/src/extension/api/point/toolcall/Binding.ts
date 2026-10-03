import {
    ToolCallHookSequence,
    type ToolCallHookContext,
    type ToolCallHookLease,
    type ToolCallHookValue,
    type ToolCallReview,
    type ToolCallReviewInput,
    type ToolCallReviewResult,
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
    type ToolCallValue,
} from "@portable-devshell/extension/toolcall";
import type { JsonValue } from "@portable-devshell/shared";

import type { ExtensionHost } from "../../../host/Host.js";
import { ToolCallSecretRewrite } from "../../interface/secret/Rewrite.js";

export interface ToolCallBuiltinReview {
    hook: string;
    id: string;
    review: (
        input: ToolCallReviewInput,
        signal: AbortSignal,
        recording: "caller" | "host",
    ) => Promise<ToolCallReviewResult> | ToolCallReviewResult;
}

interface ReviewEntry {
    extensionId?: string;
    hook: string;
    id: string;
    review: ToolCallReview;
}

export class ToolCallExtensionBinding {
    readonly #builtinReviews: readonly ToolCallBuiltinReview[];
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
        builtinReviews: readonly ToolCallBuiltinReview[] = [],
    ) {
        this.#secret = secret;
        this.#extensions = extensions;
        this.#builtinReviews = builtinReviews;
    }

    async acquire(
        _context: ToolCallHookContext,
        signal: AbortSignal,
        recording: "caller" | "host",
    ): Promise<ToolCallHookLease> {
        const releases: Array<() => void> = [];
        try {
            const reviews = await this.#acquireReviews(
                releases,
                signal,
                recording,
            );
            const rewrites = await this.#acquireRewrites(releases, signal);
            return {
                sequence: new ToolCallHookSequence({ reviews, rewrites }),
                release() {
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
        signal: AbortSignal,
        recording: "caller" | "host",
    ): Promise<readonly ToolCallReview[]> {
        const entries: ReviewEntry[] = [];
        for (const declaration of this.#extensions.listDeclarations(
            review.id,
        )) {
            const { id } = declaration;
            const { extensionId, lease, registration } =
                await this.#extensions.acquireRegistration(review.id, id);
            releases.push(() => lease.release());
            const binding = registration.binding as ToolCallReviewBinding;
            entries.push({
                extensionId,
                hook: (declaration.declaration as ToolCallExtensionDeclaration)
                    .hook,
                id,
                review: async (input) => {
                    const invocation: ToolCallReviewInvocation = {
                        callId: input.callId,
                        direction: input.direction,
                        value: extensionValue(input.value),
                    };
                    return await binding(
                        invocation,
                        reviewContext(extensionId, signal),
                    );
                },
            });
        }
        for (const builtin of this.#builtinReviews) {
            entries.push({
                hook: builtin.hook,
                id: builtin.id,
                review: async (input) =>
                    await builtin.review(input, signal, recording),
            });
        }
        return entries
            .sort(
                (left, right) =>
                    left.hook.localeCompare(right.hook) ||
                    left.id.localeCompare(right.id) ||
                    (left.extensionId ?? "").localeCompare(
                        right.extensionId ?? "",
                    ),
            )
            .map((entry) => entry.review);
    }

    async #acquireRewrites(
        releases: Array<() => void>,
        signal: AbortSignal,
    ): Promise<readonly ToolCallRewrite[]> {
        const bindings: ToolCallRewrite[] = [];
        for (const { id } of orderedHooks(
            this.#extensions.listDeclarations(rewrite.id),
        )) {
            const { extensionId, lease, registration } =
                await this.#extensions.acquireRegistration(rewrite.id, id);
            releases.push(() => lease.release());
            const binding = registration.binding as ToolCallRewriteBinding;
            const secret = this.#secret.scope(extensionId);
            bindings.push(async (input) => {
                const invocation: ToolCallRewriteInvocation = {
                    callId: input.callId,
                    direction: input.direction,
                    value: extensionValue(input.value),
                };
                return hookValue(
                    await binding(
                        invocation,
                        secret.context(invocation, signal),
                    ),
                );
            });
        }
        return bindings;
    }
}

function extensionValue(value: Readonly<ToolCallHookValue>): ToolCallValue {
    return {
        context: { ...value.context },
        kind: value.kind,
        payload: value.payload,
        toolName: value.toolName,
    };
}

function hookValue(value: ToolCallValue): ToolCallHookValue {
    return {
        context: value.context as ToolCallHookValue["context"],
        kind: value.kind,
        payload: value.payload as JsonValue,
        toolName: value.toolName,
    };
}

function orderedHooks(
    declarations: ReturnType<ExtensionHost["listDeclarations"]>,
): ReturnType<ExtensionHost["listDeclarations"]> {
    return [...declarations].sort((left, right) => {
        const leftHook = (left.declaration as ToolCallExtensionDeclaration)
            .hook;
        const rightHook = (right.declaration as ToolCallExtensionDeclaration)
            .hook;
        return (
            leftHook.localeCompare(rightHook) ||
            left.id.localeCompare(right.id) ||
            left.extensionId.localeCompare(right.extensionId)
        );
    });
}

function reviewContext(
    extensionId: string | undefined,
    signal: AbortSignal,
): ToolCallReviewContext {
    return {
        signal,
        requestInterface: async (operation: string): Promise<never> => {
            throw new TypeError(
                `Unsupported ToolCall review interface operation for Extension ${extensionId ?? "unknown"}: ${operation}.`,
            );
        },
    };
}
