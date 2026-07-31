import type { ApprovalRequest, ContextMessageRecord, ToolCallRecord } from "@portable-devshell/shared";

import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import type { TuiExpandableBoxStatus } from "../../../state/TuiUiState.js";

export interface TuiAuditContextSummary {
    readonly approvals: readonly ApprovalRequest[];
    readonly calls: readonly ToolCallRecord[];
    readonly ctxId: string;
    readonly latestActivityAt: string;
    readonly latestCall?: ToolCallRecord;
    readonly messages: readonly ContextMessageRecord[];
    readonly status: TuiExpandableBoxStatus;
}

export function projectAuditContexts(state: TuiAppState, instance: string): TuiAuditContextSummary[] {
    const contexts = new Map<string, { approvals: ApprovalRequest[]; calls: ToolCallRecord[]; messages: ContextMessageRecord[] }>();
    for (const call of state.toolCallsByInstance[instance] ?? []) {
        if (call.ctxId === undefined || call.ctxId.length === 0) continue;
        const context = contexts.get(call.ctxId) ?? { approvals: [], calls: [], messages: [] };
        context.calls.push(call);
        contexts.set(call.ctxId, context);
    }
    for (const approval of state.approvalsByInstance[instance] ?? []) {
        if (approval.ctxId === undefined || approval.ctxId.length === 0) continue;
        const context = contexts.get(approval.ctxId) ?? { approvals: [], calls: [], messages: [] };
        context.approvals.push(approval);
        contexts.set(approval.ctxId, context);
    }

    for (const message of state.contextMessagesByInstance[instance] ?? []) {
        const context = contexts.get(message.ctxId) ?? { approvals: [], calls: [], messages: [] };
        context.messages.push(message);
        contexts.set(message.ctxId, context);
    }

    return [...contexts.entries()]
        .map(([ctxId, context]) => toSummary(ctxId, context.calls, context.approvals, context.messages))
        .sort((left, right) => right.latestActivityAt.localeCompare(left.latestActivityAt));
}

export function findAuditContext(state: TuiAppState, instance: string, ctxId: string): TuiAuditContextSummary | undefined {
    return projectAuditContexts(state, instance).find((context) => context.ctxId === ctxId);
}

function toSummary(ctxId: string, calls: ToolCallRecord[], approvals: ApprovalRequest[], messages: ContextMessageRecord[]): TuiAuditContextSummary {
    const sortedCalls = [...calls].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const latestCall = sortedCalls.at(-1);
    const latestActivityAt = [
        ...sortedCalls.map((call) => call.completedAt ?? call.startedAt),
        ...approvals.map((approval) => approval.createdAt),
        ...messages.map((message) => message.deliveredAt ?? message.failedAt ?? message.createdAt)
    ].sort().at(-1) ?? "-";

    return {
        approvals: [...approvals].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        calls: sortedCalls,
        ctxId,
        latestActivityAt,
        latestCall,
        messages: [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        status: contextStatus(sortedCalls, approvals, messages)
    };
}

function contextStatus(calls: readonly ToolCallRecord[], approvals: readonly ApprovalRequest[], messages: readonly ContextMessageRecord[]): TuiExpandableBoxStatus {
    if (messages.some((message) => message.status === "failed")) return "failed";
    if (calls.some((call) => call.status === "failed" || call.status === "denied" || call.status === "queueTimeout")) return "failed";
    if (approvals.some((approval) => approval.status === "pending") || messages.some((message) => message.status === "pending")) return "pending";
    if (calls.some((call) => call.status === "running" || call.status === "queued")) return "running";
    return calls.length === 0 ? "normal" : "ready";
}
