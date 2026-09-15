import {
    formatJsonValue,
    formatRelativeTime,
    jsonSearchLimits,
    parseJsonFallback,
    toolCallOutcome,
    toolCallOutput,
    type InstanceLogEntry,
    type JsonValue,
    type ToolCallRecord,
} from "@portable-devshell/shared/browser";

export { formatRelativeTime };

export type ToolCallResult = "all" | "failure" | "pending" | "success";
export type ToolCallPeriod = "all" | "1h" | "24h";

export interface ToolCallFilters {
    ctxId: string;
    period: ToolCallPeriod;
    query: string;
    result: ToolCallResult;
    tool: string;
    workspace: string;
}

export interface ToolCallSelection {
    items: ToolCallRecord[];
    total: number;
}

const searchTextCache = new WeakMap<ToolCallRecord, string>();

export const emptyToolCallFilters: ToolCallFilters = {
    ctxId: "",
    period: "all",
    query: "",
    result: "all",
    tool: "all",
    workspace: "",
};

export function toolCallResult(
    call: ToolCallRecord,
): Exclude<ToolCallResult, "all"> {
    return toolCallOutcome(call.status);
}

export function selectToolCalls(
    calls: readonly ToolCallRecord[],
    filters: ToolCallFilters,
    now = Date.now(),
    offset = 0,
    limit = 100,
): ToolCallSelection {
    const ctxId = filters.ctxId.trim().toLowerCase();
    const query = filters.query.trim().toLowerCase();
    const workspace = filters.workspace.trim().toLowerCase();
    const minTime =
        filters.period === "1h"
            ? now - 3_600_000
            : filters.period === "24h"
              ? now - 86_400_000
              : undefined;
    const items: ToolCallRecord[] = [];
    let total = 0;
    for (const call of [...calls].sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt),
    )) {
        if (ctxId.length > 0 && (call.ctxId ?? "").toLowerCase() !== ctxId)
            continue;
        if (filters.tool !== "all" && call.toolName !== filters.tool) continue;
        if (filters.result !== "all" && toolCallResult(call) !== filters.result)
            continue;
        if (
            workspace.length > 0 &&
            !(call.workspace ?? "").toLowerCase().includes(workspace)
        )
            continue;
        if (minTime !== undefined && Date.parse(call.startedAt) < minTime)
            continue;
        if (query.length > 0 && !callSearchText(call).includes(query)) continue;
        total += 1;
        if (total > offset && items.length < limit) items.push(call);
    }
    return { items, total };
}

export function filterToolCalls(
    calls: readonly ToolCallRecord[],
    filters: ToolCallFilters,
    now = Date.now(),
): ToolCallRecord[] {
    return selectToolCalls(calls, filters, now).items;
}

export function hasActiveToolCallFilters(filters: ToolCallFilters): boolean {
    return Object.values(filters).some(
        (value) => value !== "all" && value !== "",
    );
}

function callSearchText(call: ToolCallRecord): string {
    const cached = searchTextCache.get(call);
    if (cached !== undefined) return cached;
    const text = [
        call.callId,
        call.ctxId,
        call.error,
        call.explanation,
        call.inputSummary,
        call.input === undefined
            ? undefined
            : formatToolSearchValue(call.input),
        call.output === undefined
            ? undefined
            : formatToolSearchValue(call.output),
        call.instance,
        call.requestId,
        call.purpose,
        call.source,
        call.status,
        call.toolName,
        call.workspace,
    ]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLowerCase();
    searchTextCache.set(call, text);
    return text;
}

export function formatToolValue(
    value: JsonValue | undefined,
    fallback = "-",
): string {
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
    const milliseconds =
        Date.parse(call.completedAt) - Date.parse(call.startedAt);
    return Number.isFinite(milliseconds) && milliseconds >= 0
        ? `${milliseconds}ms`
        : "-";
}
