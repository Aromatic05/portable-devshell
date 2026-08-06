import {
    formatJsonValue,
    jsonSearchLimits,
    parseJsonFallback,
    toolCallOutput,
    type InstanceLogEntry,
    type JsonValue,
    type ToolCallRecord,
} from "@portable-devshell/shared/browser";

export function formatRelativeTime(value: string, now = Date.now()): string {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return "Unknown time";
    const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

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
