import type {
    InstanceLogEntry,
    JsonValue,
    ToolCallRecord,
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

export function formatToolValue(
    value: JsonValue | undefined,
    fallback = "-",
): string {
    return formatValue(value ?? parseFallback(fallback), 0, undefined).join("\n");
}

export function resolveToolCallOutput(
    call: ToolCallRecord,
    logs: readonly InstanceLogEntry[],
): JsonValue | undefined {
    if (call.output !== undefined) return call.output;
    const linked = logs.filter((entry) => entry.callId === call.callId);
    const stdout = linked
        .filter((entry) => entry.stream === "stdout")
        .map((entry) => entry.message)
        .join("");
    const stderr = linked
        .filter((entry) => entry.stream === "stderr")
        .map((entry) => entry.message)
        .join("");
    if (stdout.length === 0 && stderr.length === 0) return undefined;
    return {
        ...(stderr.length === 0 ? {} : { stderr }),
        ...(stdout.length === 0 ? {} : { stdout }),
    };
}

export function toolCallDuration(call: ToolCallRecord): string {
    if (call.completedAt === undefined) return "running";
    const milliseconds = Date.parse(call.completedAt) - Date.parse(call.startedAt);
    return Number.isFinite(milliseconds) && milliseconds >= 0
        ? `${milliseconds}ms`
        : "-";
}

function formatValue(
    value: JsonValue,
    depth: number,
    label: string | undefined,
): string[] {
    const indent = "  ".repeat(depth);
    const prefix = label === undefined ? "" : `${indent}${label}:`;
    if (typeof value === "string") {
        const lines = value.split(/\r?\n/u);
        return lines.length === 1
            ? [`${prefix}${label === undefined ? "" : " "}${value}`]
            : [prefix, ...lines.map((line) => `${indent}  ${line}`)];
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") {
        return [`${prefix}${label === undefined ? "" : " "}${String(value)}`];
    }
    if (Array.isArray(value)) {
        return [
            prefix,
            ...value.flatMap((entry, index) =>
                formatValue(entry, depth + 1, `[${index}]`),
            ),
        ];
    }
    return [
        prefix,
        ...Object.entries(value).flatMap(([key, entry]) =>
            formatValue(entry, depth + 1, key),
        ),
    ];
}

function parseFallback(value: string): JsonValue {
    if (value.length === 0) return "-";
    try {
        return JSON.parse(value) as JsonValue;
    } catch {
        return value;
    }
}
