import {
    formatRelativeTime,
    formatJsonValue,
    jsonSearchLimits,
    parseJsonFallback,
    toolCallOutput,
    type InstanceLogEntry,
    type JsonValue,
    type ToolCallRecord,
} from "@portable-devshell/shared/browser";

export { formatRelativeTime };

export function formatToolValue(value: JsonValue | undefined, fallback = "-"): string {
    return formatJsonValue(value ?? parseJsonFallback(fallback));
}

export function formatToolSearchValue(value: JsonValue | undefined): string {
    return value === undefined ? "" : formatJsonValue(value, jsonSearchLimits);
}

export function resolveToolCallOutput(
    call: ToolCallRecord,
    logs: readonly InstanceLogEntry[],
): JsonValue | undefined {
    return toolCallOutput(call, logs);
}

export function toolCallDuration(call: ToolCallRecord): string {
    if (call.completedAt === undefined) return "running";
    const milliseconds = Date.parse(call.completedAt) - Date.parse(call.startedAt);
    return Number.isFinite(milliseconds) && milliseconds >= 0
        ? `${milliseconds}ms`
        : "-";
}
