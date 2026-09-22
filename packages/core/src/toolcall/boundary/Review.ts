import type { InstanceName, JsonValue, ToolCallContext } from "@portable-devshell/shared";
import { snapshotJson } from "./Snapshot.js";

export type ToolCallBoundaryDirection = "inbound" | "outbound";
export type ToolCallBoundaryPayloadKind = "call" | "error" | "progress" | "result";
export type ToolCallBoundaryContext = ToolCallContext & { readonly instance: InstanceName };
export type ToolCallReviewDecision = "accept" | "approve" | "reject";

export interface ToolCallReviewInput {
    readonly context: ToolCallBoundaryContext;
    readonly direction: ToolCallBoundaryDirection;
    readonly kind: ToolCallBoundaryPayloadKind;
    readonly payload: JsonValue;
    readonly signal: AbortSignal;
    readonly toolName: string;
}

export interface ToolCallReviewError {
    readonly code: string;
    readonly details?: JsonValue;
}

export interface ToolCallReviewResult {
    readonly decision: ToolCallReviewDecision;
    readonly error?: ToolCallReviewError;
    readonly feedback?: readonly string[];
    readonly reason?: string;
}

export type ToolCallReview = (
    input: ToolCallReviewInput,
) => Promise<ToolCallReviewResult> | ToolCallReviewResult;

const decisionRank: Readonly<Record<ToolCallReviewDecision, number>> = {
    accept: 0,
    approve: 1,
    reject: 2,
};

export async function reviewToolCall(
    reviews: readonly ToolCallReview[],
    input: ToolCallReviewInput,
): Promise<ToolCallReviewResult> {
    const canonicalInput = Object.freeze({
        ...input,
        context: Object.freeze({ ...input.context }),
        payload: snapshotJson(input.payload),
    });
    let result: ToolCallReviewResult = Object.freeze({ decision: "accept" });
    const feedback: string[] = [];

    for (const review of reviews) {
        const candidate = await review(canonicalInput);
        assertReviewResult(candidate);
        if (candidate.feedback !== undefined) feedback.push(...candidate.feedback);
        if (decisionRank[candidate.decision] <= decisionRank[result.decision])
            continue;
        result = Object.freeze({
            decision: candidate.decision,
            ...(candidate.error === undefined
                ? {}
                : {
                      error: Object.freeze({
                          code: candidate.error.code,
                          ...(candidate.error.details === undefined
                              ? {}
                              : {
                                    details: snapshotJson(candidate.error.details),
                                }),
                      }),
                  }),
            ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
        });
    }

    return Object.freeze({
        ...result,
        ...(feedback.length === 0 ? {} : { feedback: Object.freeze(feedback) }),
    });
}

function assertReviewResult(value: ToolCallReviewResult): void {
    if (!Object.hasOwn(decisionRank, value.decision))
        throw new TypeError(`Unknown ToolCall review decision: ${String(value.decision)}.`);
    if (value.feedback !== undefined) {
        if (!Array.isArray(value.feedback))
            throw new TypeError("ToolCall review feedback must be an array.");
        for (const entry of value.feedback) {
            if (typeof entry !== "string" || entry.length === 0)
                throw new TypeError(
                    "ToolCall review feedback entries must be non-empty strings.",
                );
        }
    }
    if (value.reason !== undefined && typeof value.reason !== "string")
        throw new TypeError("ToolCall review reason must be a string.");
    if (value.error !== undefined) {
        if (typeof value.error.code !== "string" || value.error.code.length === 0)
            throw new TypeError("ToolCall review error code must be a non-empty string.");
        if (value.error.details !== undefined) snapshotJson(value.error.details);
    }
}
