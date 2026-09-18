import type { ExtensionJsonValue } from "@portable-devshell/extension";
import {
    commentFeedbackInterfaceOperation,
    commentReviewInterfaceOperation,
    type ExtensionCommentControlDecision,
} from "@portable-devshell/extension/comment";
import type {
    ToolCallReviewContext,
    ToolCallReviewInvocation,
} from "@portable-devshell/extension/toolcall";

export interface ToolCallCommentPort {
    feedback(input: ToolCallReviewInvocation): readonly string[];
    reviewToolCall(
        instance: string,
        ctxId: string,
        toolName: string,
        requestId?: string,
    ): Promise<ExtensionCommentControlDecision>;
}

export class ToolCallCommentReview {
    readonly #comment?: ToolCallCommentPort;

    constructor(
        comment?: ToolCallCommentPort,
    ) {
        this.#comment = comment;
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
                if (extensionId !== "comment") {
                    throw new TypeError(
                        `Unsupported ToolCall review interface operation for Extension ${extensionId ?? "unknown"}: ${operation}.`,
                    );
                }
                if (requestInput !== undefined) {
                    throw new TypeError(
                        `${operation} does not accept Extension-provided input.`,
                    );
                }
                if (operation === commentReviewInterfaceOperation)
                    return (await this.#review(input)) as ExtensionJsonValue;
                if (operation === commentFeedbackInterfaceOperation)
                    return [...this.#requireComment().feedback(input)] as ExtensionJsonValue;
                throw new TypeError(
                    `Unsupported ToolCall review interface operation for Extension ${extensionId}: ${operation}.`,
                );
            },
        });
    }

    async #review(
        input: ToolCallReviewInvocation,
    ): Promise<ExtensionCommentControlDecision> {
        const ctxId = input.context.ctxId;
        if (ctxId === undefined)
            throw new TypeError("Comment review requires a Context id.");
        return await this.#requireComment().reviewToolCall(
            input.context.instance,
            ctxId,
            input.toolName,
            input.context.requestId,
        );
    }

    #requireComment(): ToolCallCommentPort {
        if (this.#comment !== undefined) return this.#comment;
        throw new Error("ToolCall Comment review interface is unavailable.");
    }
}
