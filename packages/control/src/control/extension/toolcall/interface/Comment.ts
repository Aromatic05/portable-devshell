import type { ExtensionJsonValue } from "@portable-devshell/extension";
import {
    commentReviewInterfaceOperation,
    type ExtensionCommentControlDecision,
} from "@portable-devshell/extension/comment";
import type {
    ToolCallReviewContext,
    ToolCallReviewInvocation,
} from "@portable-devshell/extension/toolcall";
import { createError, errorCodes } from "@portable-devshell/shared";

import type { InstanceRegistry } from "../../../instance/registry/Registry.js";

export class ToolCallCommentReview {
    readonly #instances?: Pick<InstanceRegistry, "get">;

    constructor(instances?: Pick<InstanceRegistry, "get">) {
        this.#instances = instances;
    }

    context(
        extensionId: string | undefined,
        input: ToolCallReviewInvocation,
    ): ToolCallReviewContext {
        return Object.freeze({
            requestInterface: async (
                operation: string,
                requestInput?: ExtensionJsonValue,
            ): Promise<ExtensionJsonValue | undefined> => {
                if (
                    extensionId !== "comment" ||
                    operation !== commentReviewInterfaceOperation
                ) {
                    throw new TypeError(
                        `Unsupported ToolCall review interface operation for Extension ${extensionId ?? "unknown"}: ${operation}.`,
                    );
                }
                if (requestInput !== undefined) {
                    throw new TypeError(
                        `${commentReviewInterfaceOperation} does not accept Extension-provided input.`,
                    );
                }
                return (await this.#review(input)) as ExtensionJsonValue;
            },
        });
    }

    async #review(
        input: ToolCallReviewInvocation,
    ): Promise<ExtensionCommentControlDecision> {
        if (
            input.direction !== "inbound" ||
            input.kind !== "call" ||
            input.context.source !== "mcp" ||
            input.context.ctxId === undefined
        ) {
            return { kind: "allow" };
        }
        const instances = this.#instances;
        if (instances === undefined) {
            throw new Error("ToolCall Comment review interface is unavailable.");
        }
        const descriptor = instances.get(input.context.instance);
        if (descriptor === undefined) {
            throw createError({
                code: errorCodes.instanceMissing,
                details: { instance: input.context.instance },
                message: `Instance ${input.context.instance} was not found or is disabled.`,
                retryable: false,
            });
        }
        const service = descriptor.contextMessages;
        if (service === undefined) return { kind: "allow" };
        return await service.reviewToolCall(
            input.context.ctxId,
            input.toolName,
            input.context.requestId,
        );
    }
}
