import type {
    JsonValue,
} from "@portable-devshell/shared";
import { snapshotJson } from "./Snapshot.js";
import type { ToolCallHookContext, ToolCallHookKind, ToolCallHookValue, ToolCallReviewInput, ToolCallReviewResult } from "../../Api.js";

export type {
    ToolCallHookContext,
    ToolCallHookDirection,
    ToolCallHookKind,
    ToolCallHookValue,
    ToolCallReviewInput,
    ToolCallReviewResult,
} from "../../Api.js";

export interface ToolCallReviewValue {
    readonly context: Readonly<ToolCallHookContext>;
    readonly kind: ToolCallHookKind;
    readonly payload: JsonValue;
    readonly toolName: string;
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
