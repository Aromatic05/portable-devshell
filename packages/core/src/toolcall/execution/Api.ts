import type { JsonValue, ToolCallContext, ToolCallPresentation } from "@portable-devshell/shared";
import type { ToolCallHookValue } from "./hook/Review.js";

/**
 * Cross-domain surface for issuing ToolCalls. Consumers depend on this instead
 * of the concrete pipeline so hook sequencing stays internal.
 */
export interface ToolCallApi {
    call(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        transformResult?: (
            result: JsonValue,
            callId: string,
            presentation?: ToolCallPresentation,
        ) => Promise<JsonValue>,
        invocationInput?: (
            input: JsonValue,
            callId: string,
            finalValue: ToolCallHookValue,
        ) => Promise<JsonValue> | JsonValue,
        onProgress?: (progress: JsonValue) => void,
        recording?: "caller" | "host",
    ): Promise<JsonValue>;
}

