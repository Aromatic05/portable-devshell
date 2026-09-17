import type { JsonValue } from "@portable-devshell/shared";

import type {
    ToolCallBoundaryContext,
    ToolCallBoundaryDirection,
    ToolCallBoundaryPayloadKind,
} from "./Review.js";

export type ToolCallRewritePath = readonly (number | string)[];

export interface ToolCallRewriteInput {
    readonly context: ToolCallBoundaryContext;
    readonly direction: ToolCallBoundaryDirection;
    readonly kind: ToolCallBoundaryPayloadKind;
    readonly path: ToolCallRewritePath;
    readonly signal: AbortSignal;
    readonly text: string;
    readonly toolName: string;
}

export type ToolCallRewrite = (
    input: ToolCallRewriteInput,
) => Promise<string> | string;

export interface ToolCallRewritePayloadInput {
    readonly context: ToolCallBoundaryContext;
    readonly direction: ToolCallBoundaryDirection;
    readonly kind: ToolCallBoundaryPayloadKind;
    readonly payload: JsonValue;
    readonly signal: AbortSignal;
    readonly toolName: string;
}

export async function rewriteToolCallPayload(
    rewrites: readonly ToolCallRewrite[],
    input: ToolCallRewritePayloadInput,
): Promise<JsonValue> {
    const stack =
        input.direction === "inbound" ? rewrites : [...rewrites].reverse();
    return await rewriteJson(input.payload, [], stack, input);
}

async function rewriteJson(
    value: JsonValue,
    path: readonly (number | string)[],
    rewrites: readonly ToolCallRewrite[],
    input: ToolCallRewritePayloadInput,
): Promise<JsonValue> {
    if (typeof value === "string") {
        let text = value;
        for (const rewrite of rewrites) {
            const next = await rewrite(
                Object.freeze({
                    context: input.context,
                    direction: input.direction,
                    kind: input.kind,
                    path: Object.freeze([...path]),
                    signal: input.signal,
                    text,
                    toolName: input.toolName,
                }),
            );
            if (typeof next !== "string")
                throw new TypeError("ToolCall rewrite must return a string.");
            text = next;
        }
        return text;
    }
    if (Array.isArray(value)) {
        const result: JsonValue[] = [];
        for (const [index, child] of value.entries())
            result.push(await rewriteJson(child, [...path, index], rewrites, input));
        return result;
    }
    if (typeof value !== "object" || value === null) return value;

    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value))
        result[key] = await rewriteJson(child, [...path, key], rewrites, input);
    return result;
}
