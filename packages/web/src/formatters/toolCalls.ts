import type {
    InstanceLogEntry,
    JsonValue,
    ToolCallRecord,
} from "@portable-devshell/shared/browser";

interface FormatLimits {
    depth: number;
    entries: number;
    formattedLength: number;
    stringLength: number;
}

const detailLimits: FormatLimits = {
    depth: 32,
    entries: 1_000,
    formattedLength: 200_000,
    stringLength: 100_000,
};
const searchLimits: FormatLimits = {
    depth: 8,
    entries: 100,
    formattedLength: 16_384,
    stringLength: 4_096,
};
const truncation = "… [truncated]";

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
    return formatWithLimits(value ?? parseFallback(fallback), detailLimits);
}

export function formatToolSearchValue(value: JsonValue | undefined): string {
    return value === undefined ? "" : formatWithLimits(value, searchLimits);
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

function formatWithLimits(value: JsonValue, limits: FormatLimits): string {
    const formatted = formatValue(value, 0, undefined, limits).join("\n");
    return formatted.length <= limits.formattedLength
        ? formatted
        : `${formatted.slice(0, limits.formattedLength - truncation.length - 1)}\n${truncation}`;
}

function formatValue(
    value: JsonValue,
    depth: number,
    label: string | undefined,
    limits: FormatLimits,
): string[] {
    const indent = "  ".repeat(Math.min(depth, limits.depth));
    const prefix = label === undefined ? "" : `${indent}${label}:`;
    if (depth >= limits.depth) {
        return [`${prefix}${label === undefined ? "" : " "}${truncation} (max depth)`];
    }
    if (typeof value === "string") {
        const limited = value.length <= limits.stringLength
            ? value
            : `${value.slice(0, limits.stringLength - truncation.length)}${truncation}`;
        const lines = limited.split(/\r?\n/u);
        return lines.length === 1
            ? [`${prefix}${label === undefined ? "" : " "}${limited}`]
            : [prefix, ...lines.map((line) => `${indent}  ${line}`)];
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") {
        return [`${prefix}${label === undefined ? "" : " "}${String(value)}`];
    }
    if (Array.isArray(value)) {
        const entries = value.slice(0, limits.entries);
        return [
            prefix,
            ...entries.flatMap((entry, index) =>
                formatValue(entry, depth + 1, `[${index}]`, limits),
            ),
            ...(value.length <= limits.entries
                ? []
                : [`${"  ".repeat(depth + 1)}${truncation} (${value.length - limits.entries} entries)`]),
        ];
    }
    const entries = Object.entries(value);
    return [
        prefix,
        ...entries.slice(0, limits.entries).flatMap(([key, entry]) =>
            formatValue(entry, depth + 1, key, limits),
        ),
        ...(entries.length <= limits.entries
            ? []
            : [`${"  ".repeat(depth + 1)}${truncation} (${entries.length - limits.entries} entries)`]),
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
