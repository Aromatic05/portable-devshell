import type { ToolCallHookDirection, ToolCallHookValue } from "./Review.js";

export interface ToolCallRewriteInput {
    readonly callId: string;
    readonly direction: ToolCallHookDirection;
    readonly value: ToolCallHookValue;
}

export type ToolCallRewrite = (
    input: ToolCallRewriteInput,
) => Promise<ToolCallHookValue> | ToolCallHookValue;

export async function rewriteToolCallValue(
    rewrites: readonly ToolCallRewrite[],
    input: ToolCallRewriteInput,
): Promise<ToolCallHookValue> {
    let value = input.value;
    for (const rewrite of rewrites)
        value = await rewrite(Object.freeze({ ...input, value }));
    return value;
}
