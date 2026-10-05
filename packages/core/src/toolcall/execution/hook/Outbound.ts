import {
    type JsonValue,
    type RemoteErrorBody,
} from "@portable-devshell/shared";

import { createErrorFromBody } from "../Error.js";
import { attachToolCallErrorPayload } from "../ErrorPayload.js";
import type { ToolCallHookValue } from "./Review.js";
import type { ToolCallHookSequenceApi } from "../../Api.js";

export async function runOutboundReview(
    hooks: ToolCallHookSequenceApi,
    input: Parameters<ToolCallHookSequenceApi["review"]>[0],
): Promise<void> {
    try {
        await hooks.review(input);
    } catch (error) {
        console.warn(error instanceof Error ? error : new Error(String(error)));
    }
}

export async function runOutboundPipeline(
    hooks: ToolCallHookSequenceApi,
    input: Parameters<ToolCallHookSequenceApi["rewrite"]>[0],
): Promise<ToolCallHookValue> {
    const value = await hooks.rewrite(input);
    await runOutboundReview(hooks, { ...input, value });
    return value;
}

export async function interpretTerminalValue(
    value: ToolCallHookValue,
    onProgress?: (progress: JsonValue) => void,
): Promise<{ error?: Error; result?: JsonValue }> {
    if (value.kind === "error") {
        const body = (value.payload as Record<string, JsonValue>)
            .error as unknown as RemoteErrorBody;
        return {
            error: attachToolCallErrorPayload(
                createErrorFromBody(body),
                value.payload,
            ),
        };
    }
    if (value.kind === "progress") {
        try {
            onProgress?.(value.payload);
        } catch (error) {
            console.warn(
                error instanceof Error ? error : new Error(String(error)),
            );
        }
    }
    // Terminal progress/call values have no downstream consumer; expose their payload as the result.
    return { result: value.payload };
}
