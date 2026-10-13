import type { JsonValue } from "@portable-devshell/shared";
import { isPresentationBinaryPayload, isPresentationSecretKey, redactPresentationText } from "./Presentation.js";

export const mcpAppWidgetPayloadKey = "portable-devshell/widgetPayload";
export const mcpAppWidgetPayloadSchema = "portable-devshell.toolcall.v1";


/** A bounded presentation snapshot, independent of Live Context leases.
 * It must never copy native image blobs or credentials into result metadata. */
function widgetPreview(value: JsonValue, limit: number): JsonValue {
    let remaining = limit;
    const read = (entry: JsonValue, depth: number): JsonValue => {
        if (remaining <= 0) return "[truncated]";
        if (typeof entry === "string") {
            const masked = redactPresentationText(entry);
            const maximum = Math.min(remaining, 16_000);
            const truncated = masked.length > maximum;
            const text = masked.slice(0, maximum);
            remaining -= text.length;
            return truncated ? text + "\n[truncated]" : text;
        }
        if (entry === null || typeof entry !== "object") return entry;
        if (depth >= 7) return "[nested value]";
        if (Array.isArray(entry))
            return entry.slice(0, 40).map((item) => read(item, depth + 1));
        const result: Record<string, JsonValue> = {};
        for (const [key, item] of Object.entries(entry).slice(0, 50)) {
            if (remaining <= 0) break;
            remaining -= key.length;
            result[key] = isPresentationSecretKey(key) ? "[redacted]" :
                isPresentationBinaryPayload(key, item) ? "[binary payload omitted]" :
                    read(item, depth + 1);
        }
        return result;
    };
    return read(value, 0);
}

export function mcpAppToolCallWidgetPayload(
    toolName: string, input: JsonValue | undefined, output: JsonValue, isError: boolean,
): Record<string, JsonValue> {
    return {
        schema: mcpAppWidgetPayloadSchema,
        toolName,
        isError,
        ...(input === undefined ? {} : { input: widgetPreview(input, 3_000) }),
        output: widgetPreview(output, 32_000),
    };
}
