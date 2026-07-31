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

export const allContextsFilter = "all";
export const unscopedContextFilter = "unscoped";
const scopedContextPrefix = "context:";

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

export function filterToolCalls(
    calls: readonly ToolCallRecord[],
    filters: ToolCallFilters,
    now = Date.now(),
): ToolCallRecord[] {
    const query = filters.query.trim().toLowerCase();
    const minTime =
        filters.period === "1h"
            ? now - 3_600_000
            : filters.period === "24h"
              ? now - 86_400_000
              : undefined;
    return [...calls]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .filter(
            (call) =>
                filters.instance === "all" || call.instance === filters.instance,
        )
        .filter((call) => {
            if (filters.ctxId === allContextsFilter) return true;
            if (filters.ctxId === unscopedContextFilter) return call.ctxId === undefined;
            return call.ctxId === selectedContextId(filters.ctxId);
        })
        .filter(
            (call) => filters.tool === "all" || call.toolName === filters.tool,
        )
        .filter(
            (call) =>
                filters.result === "all" ||
                toolCallResult(call) === filters.result,
        )
        .filter(
            (call) =>
                minTime === undefined || Date.parse(call.startedAt) >= minTime,
        )
        .filter(
            (call) => query.length === 0 || callSearchText(call).includes(query),
        )
        .slice(0, 100);
}

export function hasActiveToolCallFilters(filters: ToolCallFilters): boolean {
    return Object.values(filters).some((value) => value !== "all" && value !== "");
}

function callSearchText(call: ToolCallRecord): string {
    return [
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
}

export function contextFilterValue(ctxId: string): string {
    return `${scopedContextPrefix}${ctxId}`;
}

export function selectedContextId(value: string): string | undefined {
    return value.startsWith(scopedContextPrefix)
        ? value.slice(scopedContextPrefix.length)
        : undefined;
}
