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
        payload: freezeJson(cloneJson(input.payload)),
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
                                    details: freezeJson(
                                        cloneJson(candidate.error.details),
                                    ),
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
        if (value.error.details !== undefined) cloneJson(value.error.details);
    }
}

function cloneJson(value: JsonValue): JsonValue {
    if (!isJsonContainer(value)) return value;

    const root = createJsonContainer(value);
    const clones = new Map<object, JsonContainer>([[value, root]]);
    const stack: Array<{ source: JsonContainer; target: JsonContainer }> = [
        { source: value, target: root },
    ];
    while (stack.length > 0) {
        const frame = stack.pop()!;
        if (Array.isArray(frame.source)) {
            const target = frame.target as JsonValue[];
            for (let index = 0; index < frame.source.length; index += 1) {
                const child = frame.source[index] as JsonValue;
                const cloned = cloneJsonChild(child, clones, stack);
                target[index] = cloned;
            }
            continue;
        }
        const target = frame.target as Record<string, JsonValue>;
        for (const [key, child] of Object.entries(frame.source)) {
            defineJsonProperty(target, key, cloneJsonChild(child, clones, stack));
        }
    }
    return root;
}

function freezeJson(value: JsonValue): JsonValue {
    if (!isJsonContainer(value)) return value;
    const seen = new Set<object>();
    const stack: JsonContainer[] = [value];
    const containers: JsonContainer[] = [];
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (seen.has(current)) continue;
        seen.add(current);
        containers.push(current);
        for (const child of Object.values(current)) {
            if (isJsonContainer(child)) stack.push(child);
        }
    }
    for (let index = containers.length - 1; index >= 0; index -= 1)
        Object.freeze(containers[index]);
    return value;
}

type JsonContainer = JsonValue[] | Record<string, JsonValue>;

function isJsonContainer(value: JsonValue): value is JsonContainer {
    return typeof value === "object" && value !== null;
}

function createJsonContainer(value: JsonContainer): JsonContainer {
    return Array.isArray(value) ? new Array<JsonValue>(value.length) : {};
}

function cloneJsonChild(
    value: JsonValue,
    clones: Map<object, JsonContainer>,
    stack: Array<{ source: JsonContainer; target: JsonContainer }>,
): JsonValue {
    if (!isJsonContainer(value)) return value;
    const existing = clones.get(value);
    if (existing !== undefined) return existing;
    const cloned = createJsonContainer(value);
    clones.set(value, cloned);
    stack.push({ source: value, target: cloned });
    return cloned;
}

function defineJsonProperty(
    target: Record<string, JsonValue>,
    key: string,
    value: JsonValue,
): void {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
    });
}
