import type { JsonValue } from "@portable-devshell/shared";

const AUDIT_PREVIEW_MAX_LENGTH = 80;
const TRUNCATION = "… [truncated]";

interface AuditLinkedLog {
    callId?: string;
    ctxId?: string;
    message?: string;
    stream: "stderr" | "stdout";
}

interface FormatLimits {
    depth: number;
    formattedLength: number;
    nodes: number;
    stringLength: number;
}

const detailLimits: FormatLimits = {
    depth: 32,
    formattedLength: 200_000,
    nodes: 1_000,
    stringLength: 100_000,
};
const summaryLimits: FormatLimits = {
    depth: 8,
    formattedLength: 2_048,
    nodes: 100,
    stringLength: 1_024,
};

export function resolveAuditCtxId(ctxId: string | undefined, logs: readonly AuditLinkedLog[], callId: string): string | undefined {
    return ctxId ?? logs.find((entry) => entry.callId === callId && entry.ctxId !== undefined)?.ctxId;
}

export function resolveAuditOutput(output: JsonValue | undefined, logs: readonly AuditLinkedLog[], callId: string): JsonValue | undefined {
    if (output !== undefined) return output;
    const linked = logs.filter((entry) => entry.callId === callId);
    const stdout = linked.filter((entry) => entry.stream === "stdout").map((entry) => entry.message ?? "").join("");
    const stderr = linked.filter((entry) => entry.stream === "stderr").map((entry) => entry.message ?? "").join("");
    if (stdout.length === 0 && stderr.length === 0) return undefined;
    return {
        ...(stderr.length === 0 ? {} : { stderr }),
        ...(stdout.length === 0 ? {} : { stdout }),
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
    return formatWithLimits(value, detailLimits);
}

function auditValueSummary(value: JsonValue): string {
    const normalized = formatWithLimits(value, summaryLimits).replace(/\s+/gu, " ").trim();
    if (normalized.length <= AUDIT_PREVIEW_MAX_LENGTH) return normalized;
    return `${normalized.slice(0, AUDIT_PREVIEW_MAX_LENGTH - 1)}…`;
}

function formatWithLimits(value: JsonValue, limits: FormatLimits): string {
    const writer = new BoundedFormatWriter(limits);
    writer.write(value, 0, undefined);
    return writer.result();
}

class BoundedFormatWriter {
    readonly #parts: string[] = [];
    #length = 0;
    #remainingNodes: number;
    #stopped = false;

    constructor(private readonly limits: FormatLimits) {
        this.#remainingNodes = limits.nodes;
    }

    write(value: JsonValue, depth: number, label: string | undefined): void {
        if (this.#stopped) return;
        if (this.#remainingNodes <= 0) {
            this.stop(depth, "node budget");
            return;
        }
        this.#remainingNodes -= 1;
        const indent = "  ".repeat(Math.min(depth, this.limits.depth));
        const prefix = label === undefined ? "" : `${indent}${label}:`;
        if (depth >= this.limits.depth) {
            this.append(`${prefix}${label === undefined ? "" : " "}${TRUNCATION} (max depth)`);
            return;
        }
        if (typeof value === "string") {
            const limited = value.length <= this.limits.stringLength
                ? value
                : `${value.slice(0, Math.max(0, this.limits.stringLength - TRUNCATION.length))}${TRUNCATION}`;
            const lines = limited.split(/\r?\n/u);
            if (lines.length === 1) {
                this.append(`${prefix}${label === undefined ? "" : " "}${limited}`);
                return;
            }
            this.append(prefix);
            for (const line of lines) {
                if (!this.append(`${indent}  ${line}`)) return;
            }
            return;
        }
        if (value === null || typeof value === "boolean" || typeof value === "number") {
            this.append(`${prefix}${label === undefined ? "" : " "}${String(value)}`);
            return;
        }
        this.append(prefix);
        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index += 1) {
                if (this.#stopped || this.#remainingNodes <= 0) {
                    this.stop(depth + 1, `${value.length - index} entries`);
                    return;
                }
                this.write(value[index]!, depth + 1, `[${index}]`);
            }
            return;
        }
        for (const key of Object.keys(value)) {
            if (this.#stopped || this.#remainingNodes <= 0) {
                this.stop(depth + 1, "node budget");
                return;
            }
            this.write(value[key]!, depth + 1, key);
        }
    }

    result(): string {
        return this.#parts.join("\n");
    }

    private append(line: string): boolean {
        if (this.#stopped) return false;
        const separator = this.#parts.length === 0 ? 0 : 1;
        const available = this.limits.formattedLength - this.#length - separator;
        if (available <= 0) {
            this.#stopped = true;
            return false;
        }
        if (line.length <= available) {
            this.#parts.push(line);
            this.#length += separator + line.length;
            return true;
        }
        const marker = TRUNCATION.length <= available
            ? `${line.slice(0, Math.max(0, available - TRUNCATION.length))}${TRUNCATION}`
            : TRUNCATION.slice(0, available);
        this.#parts.push(marker);
        this.#length += separator + marker.length;
        this.#stopped = true;
        return false;
    }

    private stop(depth: number, reason: string): void {
        if (this.#stopped) return;
        this.append(`${"  ".repeat(Math.min(depth, this.limits.depth))}${TRUNCATION} (${reason})`);
        this.#stopped = true;
    }
}

function parseFallback(value: string | undefined): JsonValue {
    if (value === undefined || value.length === 0) return "-";
    try {
        return JSON.parse(value) as JsonValue;
    } catch {
        return value;
    }
}
