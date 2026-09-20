import {
    readCommentFeedback,
    reviewCommentToolCall,
    type ExtensionCommentControlDecision,
} from "@portable-devshell/extension/comment";
import type {
    ToolCallReviewBinding,
    ToolCallReviewContext,
    ToolCallReviewInvocation,
    ToolCallReviewResult,
} from "@portable-devshell/extension/toolcall";

export function createCommentReview(): ToolCallReviewBinding {
    return async (
        input: ToolCallReviewInvocation,
        context: ToolCallReviewContext,
    ): Promise<ToolCallReviewResult> => {
        if (
            input.direction === "outbound" &&
            (input.kind === "result" || input.kind === "error")
        ) {
            const feedback = await readCommentFeedback(context);
            return {
                decision: "accept",
                ...(feedback.length === 0 ? {} : { feedback }),
            };
        }
        if (
            input.direction !== "inbound" ||
            input.kind !== "call" ||
            input.context.source !== "mcp" ||
            input.context.ctxId === undefined
        ) {
            return { decision: "accept" };
        }
        return reviewDecision(await reviewCommentToolCall(context));
    };
}

function reviewDecision(
    decision: ExtensionCommentControlDecision,
): ToolCallReviewResult {
    switch (decision.kind) {
        case "allow":
            return { decision: "accept" };
        case "push":
            return {
                decision: "reject",
                error: {
                    code: "control.modelReplyRequired",
                    details: {
                        commentId: decision.commentId,
                        toolCallBudget: decision.toolCallBudget,
                    },
                },
                reason: [
                    "#push response deadline reached.",
                    "You must reply to the user's #push message before using more tools.",
                    `#push message: ${decision.comment}`,
                    "Call todo_report with a direct response to the #push message above.",
                ].join("\n\n"),
            };
        case "resume":
            return {
                decision: "reject",
                error: {
                    code: "control.modelResumed",
                    details: { commentId: decision.commentId },
                },
                reason: `The user sent #resume. This tool was not executed. Read the Comment before deciding the next action: ${decision.comment}`,
            };
        case "stop":
            return {
                decision: "reject",
                error: {
                    code: "control.modelStopped",
                    details: { commentId: decision.commentId },
                },
                reason:
                    decision.comment === undefined
                        ? "Stopped by user. Tool calls are disabled until the user sends #resume."
                        : `Stopped by user. Tool calls are disabled until the user sends #resume. User Comment: ${decision.comment}`,
            };
    }
}
