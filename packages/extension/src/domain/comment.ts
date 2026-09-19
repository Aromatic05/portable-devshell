import type { ExtensionJsonValue } from "../ExtensionApi.js";
import type { ToolCallReviewContext } from "./toolcall.js";

export const commentFeedbackInterfaceOperation = "comment.feedback";
export const commentReviewInterfaceOperation = "comment.reviewToolCall";

export type ExtensionCommentControlDecision =
    | { readonly kind: "allow" }
    | {
          readonly comment: string;
          readonly commentId: string;
          readonly kind: "push";
          readonly replyCommentId: string;
          readonly toolCallBudget: number;
      }
    | {
          readonly comment: string;
          readonly commentId: string;
          readonly kind: "resume";
      }
    | {
          readonly comment?: string;
          readonly commentId: string;
          readonly kind: "stop";
      };

export async function readCommentFeedback(
    context: Pick<ToolCallReviewContext, "requestInterface">,
): Promise<readonly string[]> {
    const value = await context.requestInterface(commentFeedbackInterfaceOperation);
    if (!Array.isArray(value))
        throw new TypeError("Comment feedback interface returned invalid feedback.");
    const feedback = value.filter(
        (entry): entry is string =>
            typeof entry === "string" && entry.length > 0,
    );
    if (feedback.length !== value.length)
        throw new TypeError("Comment feedback interface returned invalid feedback.");
    return Object.freeze(feedback);
}

export async function reviewCommentToolCall(
    context: Pick<ToolCallReviewContext, "requestInterface">,
): Promise<ExtensionCommentControlDecision> {
    const value = await context.requestInterface(commentReviewInterfaceOperation);
    return readDecision(value);
}

function readDecision(value: ExtensionJsonValue | undefined): ExtensionCommentControlDecision {
    if (!isRecord(value) || typeof value.kind !== "string")
        throw new TypeError("Comment review interface returned an invalid decision.");
    switch (value.kind) {
        case "allow":
            return { kind: "allow" };
        case "push":
            return {
                comment: readString(value.comment, "comment"),
                commentId: readString(value.commentId, "commentId"),
                kind: "push",
                replyCommentId: readString(
                    value.replyCommentId,
                    "replyCommentId",
                ),
                toolCallBudget: readNumber(value.toolCallBudget, "toolCallBudget"),
            };
        case "resume":
            return {
                comment: readString(value.comment, "comment"),
                commentId: readString(value.commentId, "commentId"),
                kind: "resume",
            };
        case "stop": {
            const comment =
                value.comment === undefined
                    ? undefined
                    : readString(value.comment, "comment");
            return {
                ...(comment === undefined ? {} : { comment }),
                commentId: readString(value.commentId, "commentId"),
                kind: "stop",
            };
        }
        default:
            throw new TypeError(
                `Comment review interface returned unknown decision ${JSON.stringify(value.kind)}.`,
            );
    }
}

function isRecord(
    value: ExtensionJsonValue | undefined,
): value is Record<string, ExtensionJsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: ExtensionJsonValue | undefined, field: string): string {
    if (typeof value === "string" && value.length > 0) return value;
    throw new TypeError(`Comment review ${field} must be a non-empty string.`);
}

function readNumber(value: ExtensionJsonValue | undefined, field: string): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    throw new TypeError(`Comment review ${field} must be a finite number.`);
}
