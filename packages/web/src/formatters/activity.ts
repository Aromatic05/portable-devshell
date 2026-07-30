import type { JsonValue } from "@portable-devshell/shared/browser";

const sensitiveKey = /authorization|cookie|input|output|password|secret|token|argument|command|content|(^|_)(args?|argv|cmd|script|stderr|stdout)($|_)/i;
const maxDepth = 3;
const maxEntries = 12;
const maxLength = 1200;

export function formatRelativeTime(value: string, now = Date.now()): string {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return "Unknown time";
    const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

export function formatEventPayload(value: JsonValue | undefined): string {
    if (value === undefined) return "No event payload recorded.";
    const formatted = JSON.stringify(sanitize(value, 0));
    return formatted.length > maxLength ? `${formatted.slice(0, maxLength)}…` : formatted;
}

function sanitize(value: JsonValue, depth: number): JsonValue {
    if (depth >= maxDepth) return "[truncated]";
    if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 240)}…` : value;
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, maxEntries).map((item) => sanitize(item, depth + 1));
    return Object.fromEntries(
        Object.entries(value)
            .slice(0, maxEntries)
            .map(([key, item]) => [key, sensitiveKey.test(key) ? "[redacted]" : sanitize(item, depth + 1)]),
    );
}
