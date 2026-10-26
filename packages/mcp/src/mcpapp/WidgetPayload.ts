import type { JsonValue } from "@portable-devshell/shared";
import { isPresentationBinaryPayload, isPresentationSecretKey, redactPresentationText } from "./Presentation.js";

export const mcpAppWidgetPayloadKey = "portable-devshell/widgetPayload";
export const mcpAppWidgetPayloadSchema = "portable-devshell.toolcall.v1";

/** Compute batch outcomes before any presentation truncation. */
export function mcpAppFileEditSummary(output: unknown): Record<string, JsonValue> | undefined {
    if (typeof output !== "object" || output === null || !("operations" in output) ||
        !Array.isArray(output.operations)) return undefined;
    const operations = output.operations.filter((item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item));
    const failures = operations.filter((item) => item.status === "failed");
    const lines = (key: string) => operations.reduce((sum, item) =>
        sum + (typeof item[key] === "number" && Number.isFinite(item[key]) ? item[key] : 0), 0);
    return {
        totalOperations: operations.length,
        failedOperations: failures.length,
        addedLines: lines("addedLines"),
        removedLines: lines("removedLines"),
        failures: failures.slice(0, 5).map((item) => {
            const error = typeof item.error === "object" && item.error !== null
                ? item.error as Record<string, unknown> : {};
            return [item.path, error.message ?? error.code ?? "This operation failed"]
                .filter((value): value is string => typeof value === "string")
                .map((value) => redactPresentationText(value).slice(0, 300)).join(": ");
        }),
    };
}

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
    const editSummary = toolName === "file_edit" ? mcpAppFileEditSummary(output) : undefined;
    return {
        schema: mcpAppWidgetPayloadSchema,
        toolName,
        isError,
        ...(input === undefined ? {} : { input: widgetPreview(input, 3_000) }),
        output: widgetPreview(editSummary === undefined ? output : {
            editSummary, ...output as Record<string, JsonValue>,
        }, 32_000),
    };
}
