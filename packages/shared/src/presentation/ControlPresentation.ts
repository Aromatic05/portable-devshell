import type { InstanceLogEntry } from "../dto/instance/DtoInstanceLog.js";
import type { TodoReadResult, TodoTaskSummary } from "../dto/instance/DtoTodo.js";
import type { ToolCallRecord, ToolCallStatus } from "../dto/tool/DtoToolCallRecord.js";
import type { JsonValue } from "../type/TypeJsonValue.js";

export interface JsonFormatLimits {
    depth: number;
    formattedLength: number;
    nodes: number;
    stringLength: number;
}

export const jsonDetailLimits: JsonFormatLimits = {
    depth: 32,
    formattedLength: 200_000,
    nodes: 1_000,
    stringLength: 100_000,
};

export const jsonSearchLimits: JsonFormatLimits = {
    depth: 8,
    formattedLength: 16_384,
    nodes: 100,
    stringLength: 4_096,
};

const truncation = "… [truncated]";
const failedStatuses = new Set<ToolCallStatus>([
    "cancelled",
    "denied",
    "expired",
    "failed",
    "queueTimeout",
]);
const pendingStatuses = new Set<ToolCallStatus>([
    "pendingApproval",
    "queued",
    "running",
]);

export function workspaceFolderName(workspace: string | undefined): string {
    if (workspace === undefined || workspace.length === 0) return "-";
    const normalized = workspace.replace(/[\\/]+$/u, "");
    if (normalized.length === 0) return workspace;
    return normalized.split(/[\\/]/u).at(-1) || workspace;
}

export function formatJsonValue(
    value: JsonValue,
    limits: JsonFormatLimits = jsonDetailLimits,
): string {
    const writer = new BoundedFormatWriter(limits);
    writer.write(value, 0, undefined);
    return writer.result();
}

export function formatJsonSummary(
    value: JsonValue,
    maxLength = 80,
): string {
    const normalized = formatJsonValue(value, {
        ...jsonSearchLimits,
        formattedLength: Math.max(maxLength * 4, 512),
    }).replace(/\s+/gu, " ").trim();
    return normalized.length <= maxLength
        ? normalized
        : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function parseJsonFallback(value: string | undefined): JsonValue {
    if (value === undefined || value.length === 0) return "-";
    try {
        return JSON.parse(value) as JsonValue;
    } catch {
        return value;
    }
}

export function resolveToolOutput(
    output: JsonValue | undefined,
    callId: string,
    logs: readonly Pick<InstanceLogEntry, "callId" | "message" | "stream">[],
): JsonValue | undefined {
    const linked = logs.filter((entry) => entry.callId === callId);
    const stdout = linked
        .filter((entry) => entry.stream === "stdout")
        .map((entry) => entry.message)
        .join("");
    const stderr = linked
        .filter((entry) => entry.stream === "stderr")
        .map((entry) => entry.message)
        .join("");
    if (stdout.length === 0 && stderr.length === 0) return output;
    const streams: Record<string, JsonValue> = {
        ...(stderr.length === 0 ? {} : { stderr }),
        ...(stdout.length === 0 ? {} : { stdout }),
    };
    if (output === undefined) return streams;
    if (typeof output !== "object" || output === null || Array.isArray(output)) return output;
    return { ...streams, ...output };
}

export function toolCallOutcome(
    status: ToolCallStatus,
): "failure" | "pending" | "success" {
    if (status === "completed") return "success";
    if (pendingStatuses.has(status)) return "pending";
    return failedStatuses.has(status) ? "failure" : "failure";
}

export function projectTodoTaskSummaries(
    todo: TodoReadResult | undefined,
): TodoTaskSummary[] {
    if (todo === undefined) return [];
    const summaries = new Map((todo.tasks ?? []).map((task) => [task.taskId, task]));
    if (todo.taskId !== undefined) {
        const existing = summaries.get(todo.taskId);
        summaries.set(todo.taskId, {
            completed: todo.summary.completed,
            currentItem: todo.summary.currentItemId === undefined
                ? undefined
                : todo.items.find((item) => item.id === todo.summary.currentItemId)?.content,
            revision: todo.revision,
            status: activeTodoStatus(todo),
            taskId: todo.taskId,
            title: todo.title ?? todo.taskId,
            total: todo.summary.total,
            updatedAt: existing?.updatedAt ?? "-",
            ...(existing?.ctxId === undefined ? {} : { ctxId: existing.ctxId }),
        });
    }
    return [...summaries.values()].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
    );
}

export function toolCallOutput(
    call: ToolCallRecord,
    logs: readonly InstanceLogEntry[],
): JsonValue | undefined {
    return resolveToolOutput(call.output, call.callId, logs);
}

function activeTodoStatus(todo: TodoReadResult): TodoTaskSummary["status"] {
    if (todo.items.some((item) => item.status === "failed")) return "failed";
    if (todo.items.some((item) => item.status === "blocked")) return "blocked";
    if (todo.items.some((item) => item.status === "in_progress")) return "in_progress";
    if (todo.summary.total > 0 && todo.summary.completed === todo.summary.total) return "completed";
    return todo.summary.total === 0 ? "none" : "pending";
}

class BoundedFormatWriter {
    readonly #parts: string[] = [];
    #length = 0;
    #remainingNodes: number;
    #stopped = false;

    constructor(private readonly limits: JsonFormatLimits) {
        this.#remainingNodes = limits.nodes;
    }

    write(value: JsonValue, depth: number, label: string | undefined): void {
        if (this.#stopped) return;
        if (this.#remainingNodes <= 0) return this.stop(depth, "node budget");
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
                : `${value.slice(0, Math.max(0, this.limits.stringLength - truncation.length))}${truncation}`;
            const lines = limited.split(/\r?\n/u);
            if (lines.length === 1) {
                this.append(`${prefix}${label === undefined ? "" : " "}${limited}`);
                return;
            }
            this.append(prefix);
            for (const line of lines) if (!this.append(`${indent}  ${line}`)) return;
            return;
        }
        if (value === null || typeof value === "boolean" || typeof value === "number") {
            this.append(`${prefix}${label === undefined ? "" : " "}${String(value)}`);
            return;
        }
        this.append(prefix);
        const entries = Array.isArray(value)
            ? value.map((entry, index) => [`[${index}]`, entry] as const)
            : Object.entries(value);
        for (const [key, entry] of entries) {
            if (this.#stopped || this.#remainingNodes <= 0) return this.stop(depth + 1, "node budget");
            this.write(entry, depth + 1, key);
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
        const output = line.length <= available
            ? line
            : truncation.length <= available
              ? `${line.slice(0, Math.max(0, available - truncation.length))}${truncation}`
              : truncation.slice(0, available);
        this.#parts.push(output);
        this.#length += separator + output.length;
        if (output !== line) this.#stopped = true;
        return !this.#stopped;
    }

    private stop(depth: number, reason: string): void {
        if (this.#stopped) return;
        this.append(`${"  ".repeat(Math.min(depth, this.limits.depth))}${truncation} (${reason})`);
        this.#stopped = true;
    }
}

export function formatBytes(
    value: number | undefined,
    unavailable = "Unavailable",
): string {
    if (value === undefined || !Number.isFinite(value) || value < 0) return unavailable;
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const unit = Math.min(
        Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)),
        units.length - 1,
    );
    const amount = value / 1024 ** unit;
    const digits = amount >= 100 || unit === 0 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(digits).replace(/\.0+$/u, "")} ${units[unit]}`;
}

export function formatDuration(
    seconds: number | undefined,
    unavailable = "Unavailable",
): string {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return unavailable;
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
    return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
}

export function formatPercent(
    value: number | undefined,
    unavailable = "Unavailable",
): string {
    if (value === undefined || !Number.isFinite(value) || value < 0) return unavailable;
    return `${value % 1 === 0 ? value : value.toFixed(1)}%`;
}
