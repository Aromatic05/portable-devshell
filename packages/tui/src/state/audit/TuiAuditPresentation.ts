import type { JsonValue } from "@portable-devshell/shared";

const AUDIT_PREVIEW_MAX_LENGTH = 80;

interface AuditLinkedLog {
    callId?: string;
    ctxId?: string;
    message?: string;
    stream: "stderr" | "stdout";
}

export function resolveAuditCtxId(ctxId: string | undefined, logs: readonly AuditLinkedLog[], callId: string): string | undefined {
    return ctxId ?? logs.find((entry) => entry.callId === callId && entry.ctxId !== undefined)?.ctxId;
}

export function resolveAuditOutput(output: JsonValue | undefined, logs: readonly AuditLinkedLog[], callId: string): JsonValue | undefined {
    if (output !== undefined) {
        return output;
    }
    const linked = logs.filter((entry) => entry.callId === callId);
    const stdout = linked.filter((entry) => entry.stream === "stdout").map((entry) => entry.message ?? "").join("");
    const stderr = linked.filter((entry) => entry.stream === "stderr").map((entry) => entry.message ?? "").join("");
    if (stdout.length === 0 && stderr.length === 0) {
        return undefined;
    }
    return {
        ...(stderr.length === 0 ? {} : { stderr }),
        ...(stdout.length === 0 ? {} : { stdout })
    };
}

export function auditInputText(input: JsonValue | undefined, fallback: string | undefined): string {
    return auditValueText(input === undefined ? parseFallback(fallback) : input);
}

export function auditInputSummary(input: JsonValue | undefined, fallback: string | undefined): string {
    return auditValueSummary(input === undefined ? parseFallback(fallback) : input);
}

export function auditOutputText(output: JsonValue | undefined): string {
    return auditValueText(output === undefined ? "-" : output);
}

export function auditOutputSummary(output: JsonValue | undefined): string {
    return auditValueSummary(output === undefined ? "-" : output);
}

function auditValueText(value: JsonValue): string {
    return formatValue(value, 0, undefined).join("\n");
}

function auditValueSummary(value: JsonValue): string {
    const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
    const normalized = serialized.replace(/\s+/gu, " ").trim();
    if (normalized.length <= AUDIT_PREVIEW_MAX_LENGTH) {
        return normalized;
    }
    return `${normalized.slice(0, AUDIT_PREVIEW_MAX_LENGTH - 1)}…`;
}

function formatValue(value: JsonValue, depth: number, label: string | undefined): string[] {
    const indent = "  ".repeat(depth);
    const prefix = label === undefined ? "" : `${indent}${label}:`;
    if (typeof value === "string") {
        const lines = value.split(/\r?\n/u);
        return lines.length === 1 ? [`${prefix}${label === undefined ? "" : " "}${value}`] : [prefix, ...lines.map((line) => `${indent}  ${line}`)];
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") {
        return [`${prefix}${label === undefined ? "" : " "}${String(value)}`];
    }
    if (Array.isArray(value)) {
        return [prefix, ...value.flatMap((entry, index) => formatValue(entry, depth + 1, `[${index}]`))];
    }
    return [prefix, ...Object.entries(value).flatMap(([key, entry]) => formatValue(entry, depth + 1, key))];
}

function parseFallback(value: string | undefined): JsonValue {
    if (value === undefined || value.length === 0) {
        return "-";
    }
    try {
        return JSON.parse(value) as JsonValue;
    } catch {
        return value;
    }
}

