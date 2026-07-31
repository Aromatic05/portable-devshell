import type { ToolCallRecord } from "@portable-devshell/shared/browser";

import { formatToolSearchValue } from "../formatters/toolCalls.js";

export type ToolCallResult = "all" | "failure" | "pending" | "success";
export type ToolCallPeriod = "all" | "1h" | "24h";

export interface ToolCallFilters {
    ctxId: string;
    instance: string;
    period: ToolCallPeriod;
    query: string;
    result: ToolCallResult;
    tool: string;
}

export interface ToolCallSelection {
    items: ToolCallRecord[];
    total: number;
}

export const allContextsFilter = "all";
export const unscopedContextFilter = "unscoped";
const scopedContextPrefix = "context:";
const searchTextCache = new WeakMap<ToolCallRecord, string>();

export const emptyToolCallFilters: ToolCallFilters = {
    ctxId: "all",
    instance: "all",
    period: "all",
    query: "",
    result: "all",
    tool: "all",
};

const failureStatuses = new Set([
    "cancelled",
    "denied",
    "expired",
    "failed",
    "queueTimeout",
]);

const pendingStatuses = new Set([
    "pendingApproval",
    "queued",
    "running",
]);

export function toolCallResult(
    call: ToolCallRecord,
): Exclude<ToolCallResult, "all"> {
    if (call.status === "completed") return "success";
    if (pendingStatuses.has(call.status)) return "pending";
    if (failureStatuses.has(call.status)) return "failure";
    return "failure";
}

export function selectToolCalls(
    calls: readonly ToolCallRecord[],
    filters: ToolCallFilters,
    now = Date.now(),
    limit = 100,
): ToolCallSelection {
    const query = filters.query.trim().toLowerCase();
    const minTime =
        filters.period === "1h"
            ? now - 3_600_000
            : filters.period === "24h"
              ? now - 86_400_000
              : undefined;
    const items: ToolCallRecord[] = [];
    let total = 0;
    for (const call of [...calls].sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt)
    )) {
        if (filters.instance !== "all" && call.instance !== filters.instance) continue;
        if (filters.ctxId === unscopedContextFilter && call.ctxId !== undefined) continue;
        if (
            filters.ctxId !== allContextsFilter &&
            filters.ctxId !== unscopedContextFilter &&
            call.ctxId !== selectedContextId(filters.ctxId)
        ) continue;
        if (filters.tool !== "all" && call.toolName !== filters.tool) continue;
        if (filters.result !== "all" && toolCallResult(call) !== filters.result) continue;
        if (minTime !== undefined && Date.parse(call.startedAt) < minTime) continue;
        if (query.length > 0 && !callSearchText(call).includes(query)) continue;
        total += 1;
        if (items.length < limit) items.push(call);
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
    return Object.values(filters).some((value) => value !== "all" && value !== "");
}

function callSearchText(call: ToolCallRecord): string {
    const cached = searchTextCache.get(call);
    if (cached !== undefined) return cached;
    const text = [
        call.callId,
        call.ctxId,
        call.error,
        call.inputSummary,
        call.input === undefined ? undefined : formatToolSearchValue(call.input),
        call.output === undefined ? undefined : formatToolSearchValue(call.output),
        call.instance,
        call.requestId,
        call.source,
        call.status,
        call.toolName,
    ]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLowerCase();
    searchTextCache.set(call, text);
    return text;
}

export function contextFilterValue(ctxId: string): string {
    return `${scopedContextPrefix}${ctxId}`;
}

export function selectedContextId(value: string): string | undefined {
    return value.startsWith(scopedContextPrefix)
        ? value.slice(scopedContextPrefix.length)
        : undefined;
}
