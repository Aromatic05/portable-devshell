import type {
    ToolCallHookValue,
    ToolCallRewriteInput,
} from "../../Api.js";
export type { ToolCallRewriteInput } from "../../Api.js";

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
