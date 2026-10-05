import type { JsonValue } from "../../types/Json.js";
import type {
    ToolCallContext,
    ToolCallHookValue,
    ToolCallPresentation,
} from "./Type.js";

/** Cross-domain ingress for issuing tool calls through the global pipeline. */
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
