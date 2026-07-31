import type { ApprovalRequest, ToolCallRecord } from "@portable-devshell/shared";

import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import type { TuiExpandableBoxStatus } from "../../../state/TuiUiState.js";

export interface TuiAuditContextSummary {
    readonly approvals: readonly ApprovalRequest[];
    readonly calls: readonly ToolCallRecord[];
    readonly ctxId: string;
    readonly latestActivityAt: string;
    readonly latestCall?: ToolCallRecord;
    readonly status: TuiExpandableBoxStatus;
}

export function projectAuditContexts(state: TuiAppState, instance: string): TuiAuditContextSummary[] {
    const contexts = new Map<string, { approvals: ApprovalRequest[]; calls: ToolCallRecord[] }>();
    for (const call of state.toolCallsByInstance[instance] ?? []) {
        if (call.ctxId === undefined || call.ctxId.length === 0) continue;
        const context = contexts.get(call.ctxId) ?? { approvals: [], calls: [] };
        context.calls.push(call);
        contexts.set(call.ctxId, context);
    }
    for (const approval of state.approvalsByInstance[instance] ?? []) {
        if (approval.ctxId === undefined || approval.ctxId.length === 0) continue;
        const context = contexts.get(approval.ctxId) ?? { approvals: [], calls: [] };
        context.approvals.push(approval);
        contexts.set(approval.ctxId, context);
    }

    return [...contexts.entries()]
        .map(([ctxId, context]) => toSummary(ctxId, context.calls, context.approvals))
        .sort((left, right) => right.latestActivityAt.localeCompare(left.latestActivityAt));
}

export function findAuditContext(state: TuiAppState, instance: string, ctxId: string): TuiAuditContextSummary | undefined {
    return projectAuditContexts(state, instance).find((context) => context.ctxId === ctxId);
}

function toSummary(ctxId: string, calls: ToolCallRecord[], approvals: ApprovalRequest[]): TuiAuditContextSummary {
    const sortedCalls = [...calls].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const latestCall = sortedCalls.at(-1);
    const latestActivityAt = [
        ...sortedCalls.map((call) => call.completedAt ?? call.startedAt),
        ...approvals.map((approval) => approval.createdAt)
    ].sort().at(-1) ?? "-";

    return {
        approvals: [...approvals].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        calls: sortedCalls,
        ctxId,
        latestActivityAt,
        latestCall,
        status: contextStatus(sortedCalls, approvals)
    };
}

function contextStatus(calls: readonly ToolCallRecord[], approvals: readonly ApprovalRequest[]): TuiExpandableBoxStatus {
    if (calls.some((call) => call.status === "failed" || call.status === "denied" || call.status === "queueTimeout")) return "failed";
    if (approvals.some((approval) => approval.status === "pending")) return "pending";
    if (calls.some((call) => call.status === "running" || call.status === "queued")) return "running";
    return calls.length === 0 ? "normal" : "ready";
}
