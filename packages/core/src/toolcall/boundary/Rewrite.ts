import type { JsonValue } from "@portable-devshell/shared";

import type {
    ToolCallBoundaryContext,
    ToolCallBoundaryDirection,
    ToolCallBoundaryPayloadKind,
} from "./Review.js";
import { snapshotJson } from "./Snapshot.js";

export interface ToolCallRewriteInput {
    readonly callId: string;
    readonly context: ToolCallBoundaryContext;
    readonly direction: ToolCallBoundaryDirection;
    readonly kind: ToolCallBoundaryPayloadKind;
    readonly payload: JsonValue;
    readonly signal: AbortSignal;
    readonly toolName: string;
}

export type ToolCallRewrite = (
    input: ToolCallRewriteInput,
) => Promise<JsonValue> | JsonValue;

export async function rewriteToolCallPayload(
    rewrites: readonly ToolCallRewrite[],
    input: ToolCallRewriteInput,
): Promise<JsonValue> {
    const rewritesInOrder =
        input.direction === "inbound" ? rewrites : [...rewrites].reverse();
    let payload = snapshotJson(input.payload);
    for (const rewrite of rewritesInOrder) {
        payload = snapshotJson(
            await rewrite(
                Object.freeze({
                    ...input,
                    context: Object.freeze({ ...input.context }),
                    payload,
                }),
            ),
        );
    }
    return payload;
}
