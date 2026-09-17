import type { InstanceName, JsonValue, ToolCallContext } from "@portable-devshell/shared";

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
            ...(candidate.error === undefined
                ? {}
                : {
                      error: Object.freeze({
                          code: candidate.error.code,
                          ...(candidate.error.details === undefined
                              ? {}
                              : {
                                    details: freezeJson(
                                        cloneJson(candidate.error.details),
                                    ),
                                }),
                      }),
                  }),
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
    if (value.error !== undefined) {
        if (typeof value.error.code !== "string" || value.error.code.length === 0)
            throw new TypeError("ToolCall review error code must be a non-empty string.");
        if (value.error.details !== undefined) cloneJson(value.error.details);
    }
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
