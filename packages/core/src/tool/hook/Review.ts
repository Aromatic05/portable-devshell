import type {
    InstanceName,
    JsonValue,
    ToolCallContext,
} from "@portable-devshell/shared";
import { snapshotJson } from "./Snapshot.js";

export type ToolCallHookDirection = "inbound" | "outbound";
export type ToolCallHookKind = "call" | "error" | "progress" | "result";
export type ToolCallHookContext = ToolCallContext & { instance: InstanceName };

export interface ToolCallHookValue {
    context: ToolCallHookContext;
    kind: ToolCallHookKind;
    payload: JsonValue;
    toolName: string;
}

export interface ToolCallReviewValue {
    readonly context: Readonly<ToolCallHookContext>;
    readonly kind: ToolCallHookKind;
    readonly payload: JsonValue;
    readonly toolName: string;
}

export interface ToolCallReviewInput {
    readonly callId: string;
    readonly direction: ToolCallHookDirection;
    readonly value: ToolCallReviewValue;
}

export interface ToolCallReviewError {
    readonly code: string;
    readonly details?: JsonValue;
}

export interface ToolCallReviewResult {
    readonly decision: "continue" | "reject";
    readonly error?: ToolCallReviewError;
    readonly reason?: string;
}

export type ToolCallReview = (
    input: ToolCallReviewInput,
) => Promise<ToolCallReviewResult> | ToolCallReviewResult;

export async function reviewToolCall(
    reviews: readonly ToolCallReview[],
    input: ToolCallReviewInput,
): Promise<ToolCallReviewResult> {
    const value = snapshotToolCallValue(input.value);
    for (const review of reviews) {
        const result = await review(Object.freeze({ ...input, value }));
        if (result.decision === "reject") return result;
    }
    return { decision: "continue" };
}

export function snapshotToolCallValue(
    value: Readonly<ToolCallHookValue>,
): ToolCallReviewValue {
    return snapshotJson(
        value as unknown as JsonValue,
    ) as unknown as ToolCallReviewValue;
}
