import type {
    InstanceLogEntry,
    JsonValue,
    ToolCallRecord,
} from "@portable-devshell/shared/browser";

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
const searchLimits: FormatLimits = {
    depth: 8,
    formattedLength: 16_384,
    nodes: 100,
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
            this.append(`${prefix}${label === undefined ? "" : " "}${truncation} (max depth)`);
            return;
        }
        if (typeof value === "string") {
            const limited = value.length <= this.limits.stringLength
                ? value
                : `${value.slice(0, this.limits.stringLength - truncation.length)}${truncation}`;
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
        let visited = 0;
        for (const key in value) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            if (this.#stopped || this.#remainingNodes <= 0) {
                this.stop(depth + 1, "node budget");
                return;
            }
            visited += 1;
            this.write(value[key]!, depth + 1, key);
        }
        if (visited === 0 && label !== undefined) return;
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
        const marker = truncation.length <= available
            ? `${line.slice(0, Math.max(0, available - truncation.length))}${truncation}`
            : truncation.slice(0, available);
        this.#parts.push(marker);
        this.#length += separator + marker.length;
        this.#stopped = true;
        return false;
    }

    private stop(depth: number, reason: string): void {
        if (this.#stopped) return;
        this.append(`${"  ".repeat(Math.min(depth, this.limits.depth))}${truncation} (${reason})`);
        this.#stopped = true;
    }
}

function parseFallback(value: string): JsonValue {
    if (value.length === 0) return "-";
    try {
        return JSON.parse(value) as JsonValue;
    } catch {
        return value;
    }
}
