import type {
    ToolCallHooks,
    ToolCallHookValue,
} from "@portable-devshell/shared";
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

import type { ExtensionHost } from "../../../host/index.js";
import { ToolCallSecretRewrite } from "../../interface/secret/index.js";

type ToolCallHookContributor = Parameters<
    ToolCallHooks["registerContributor"]
>[0];
type ToolCallHookContribution = Awaited<ReturnType<ToolCallHookContributor>>;
type ToolCallReviewHook = NonNullable<
    ToolCallHookContribution["reviews"]
>[number];
type ToolCallRewriteHook = NonNullable<
    ToolCallHookContribution["rewrites"]
>[number];

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

    install(hooks: ToolCallHooks): () => void {
        return hooks.registerContributor(async (_context, runtime) => {
            const releases: Array<() => void> = [];
            try {
                const reviews = await this.#acquireReviews(
                    releases,
                    runtime.signal,
                );
                const rewrites = await this.#acquireRewrites(
                    releases,
                    runtime.signal,
                );
                return {
                    reviews,
                    rewrites,
                    release() {
                        for (const release of [...releases].reverse()) release();
                    },
                };
            } catch (error) {
                for (const release of [...releases].reverse()) release();
                throw error;
            }
        });
    }

    async #acquireReviews(
        releases: Array<() => void>,
        signal: AbortSignal,
    ): Promise<readonly ToolCallReviewHook[]> {
        const entries: ToolCallReviewHook[] = [];
        for (const declaration of this.#extensions.listDeclarations(
            review.id,
        )) {
            const { id } = declaration;
            const { extensionId, lease, registration } =
                await this.#extensions.acquireRegistration(review.id, id);
            releases.push(() => lease.release());
            const binding = registration.binding as ToolCallReviewBinding;
            entries.push({
                hook: (declaration.declaration as ToolCallExtensionDeclaration)
                    .hook,
                id,
                owner: extensionId,
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
        return entries;
    }

    async #acquireRewrites(
        releases: Array<() => void>,
        signal: AbortSignal,
    ): Promise<readonly ToolCallRewriteHook[]> {
        const bindings: ToolCallRewriteHook[] = [];
        for (const declaration of this.#extensions.listDeclarations(rewrite.id)) {
            const { id } = declaration;
            const { extensionId, lease, registration } =
                await this.#extensions.acquireRegistration(rewrite.id, id);
            releases.push(() => lease.release());
            let binding = registration.binding as ToolCallRewriteBinding;
            let currentLease = lease;
            const secret = this.#secret.scope(extensionId);
            bindings.push({
                hook: (declaration.declaration as ToolCallExtensionDeclaration)
                    .hook,
                id,
                owner: extensionId,
                rewrite: async (input) => {
                    // A sandbox can retire while a long Worker command runs.
                    // Rebind before invoking the outbound hook, but never
                    // replay a hook that has already started.
                    if (input.direction === "outbound" &&
                        currentLease.retirementSignal?.aborted === true) {
                        const renewed = await this.#extensions.acquireRegistration(rewrite.id, id);
                        if (renewed.extensionId !== extensionId) {
                            renewed.lease.release();
                            throw new Error(
                                `ToolCall rewrite hook ownership changed for ${id}; result delivery is unavailable.`,
                            );
                        }
                        releases.push(() => renewed.lease.release());
                        currentLease = renewed.lease;
                        binding = renewed.registration.binding as ToolCallRewriteBinding;
                    }
                    const invocation: ToolCallRewriteInvocation = {
                        callId: input.callId,
                        direction: input.direction,
                        value: extensionValue(input.value),
                    };
                    try {
                        return hookValue(await binding(
                            invocation,
                            secret.context(invocation, signal),
                        ), input.value.context);
                    } catch (error) {
                        // Do not log hook inputs, outputs or exception messages:
                        // they may contain secrets the hook was about to mask.
                        console.warn("Extension ToolCall rewrite hook unavailable", {
                            extensionId,
                            hookId: id,
                            direction: input.direction,
                            causeCode: typeof error === "object" && error !== null &&
                                "code" in error && typeof error.code === "string"
                                ? error.code : "error.unknown",
                        });
                        throw error;
                    }
                },
            });
        }
        return bindings;
    }
}

function extensionValue(value: Readonly<ToolCallHookValue>): ToolCallValue {
    // OAuth identity and external session authority belong to the Host,
    // not to the Extension's rewritable ToolCall context.
    const {
        principal: _principal,
        externalBindings: _externalBindings,
        contextMode: _contextMode,
        ...context
    } = value.context;
    return {
        context,
        kind: value.kind,
        payload: value.payload,
        toolName: value.toolName,
    };
}

function hookValue(
    value: ToolCallValue,
    original: Readonly<ToolCallHookValue["context"]>,
): ToolCallHookValue {
    const {
        principal: _principal,
        externalBindings: _externalBindings,
        contextMode: _contextMode,
        ...context
    } = value.context as ToolCallHookValue["context"];
    return {
        context: {
            ...context,
            ...(original.principal === undefined
                ? {}
                : { principal: original.principal }),
            ...(original.externalBindings === undefined
                ? {}
                : { externalBindings: original.externalBindings }),
            ...(original.contextMode === undefined
                ? {}
                : { contextMode: original.contextMode }),
        },
        kind: value.kind,
        payload: value.payload as JsonValue,
        toolName: value.toolName,
    };
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
