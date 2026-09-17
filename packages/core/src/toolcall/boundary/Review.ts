import type { JsonValue, ToolCallContext } from "@portable-devshell/shared";

export type ToolCallBoundaryDirection = "inbound" | "outbound";
export type ToolCallBoundaryPayloadKind = "call" | "error" | "progress" | "result";
export type ToolCallReviewDecision = "accept" | "approve" | "reject";

export interface ToolCallReviewInput {
    readonly context: ToolCallContext;
    readonly direction: ToolCallBoundaryDirection;
    readonly kind: ToolCallBoundaryPayloadKind;
    readonly payload: JsonValue;
    readonly signal: AbortSignal;
    readonly toolName: string;
}

export interface ToolCallReviewResult {
    readonly decision: ToolCallReviewDecision;
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
        payload: freezeJson(cloneJson(input.payload)),
    });
    let result: ToolCallReviewResult = Object.freeze({ decision: "accept" });

    for (const review of reviews) {
        const candidate = await review(canonicalInput);
        assertReviewResult(candidate);
        if (decisionRank[candidate.decision] <= decisionRank[result.decision])
            continue;
        result = Object.freeze({
            decision: candidate.decision,
            ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
        });
    }

    return result;
}

function assertReviewResult(value: ToolCallReviewResult): void {
    if (!Object.hasOwn(decisionRank, value.decision))
        throw new TypeError(`Unknown ToolCall review decision: ${String(value.decision)}.`);
    if (value.reason !== undefined && typeof value.reason !== "string")
        throw new TypeError("ToolCall review reason must be a string.");
}

function cloneJson(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(cloneJson);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, cloneJson(child)]),
    );
}

function freezeJson(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        for (const child of value) freezeJson(child);
        return Object.freeze(value) as unknown as JsonValue;
    }
    if (typeof value !== "object" || value === null) return value;
    for (const child of Object.values(value)) freezeJson(child);
    return Object.freeze(value);
}
