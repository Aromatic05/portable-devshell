import {
    toolCallOutcome,
    type ApprovalRequest,
    type McpContextStatus,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import type { TuiExpandableBoxStatus } from "../../../state/TuiUiState.js";

export type TuiAuditContextKey =
    | { readonly kind: "unscoped" }
    | { readonly ctxId: string; readonly kind: "context" };

export interface TuiAuditContextSummary {
    readonly approvals: readonly ApprovalRequest[];
    readonly calls: readonly ToolCallRecord[];
    readonly contextStatus?: McpContextStatus;
    readonly key: TuiAuditContextKey;
    readonly label: string;
    readonly latestActivityAt: string;
    readonly latestCall?: ToolCallRecord;
    readonly status: TuiExpandableBoxStatus;
}

interface MutableAuditContext {
    approvals: ApprovalRequest[];
    calls: ToolCallRecord[];
    key: TuiAuditContextKey;
    label: string;
}

export function projectAuditContexts(
    state: TuiAppState,
    instance: string,
): TuiAuditContextSummary[] {
    const contexts = new Map<string, MutableAuditContext>();
    const resolve = (ctxId: string | undefined): MutableAuditContext => {
        const key: TuiAuditContextKey =
            ctxId === undefined || ctxId.length === 0
                ? { kind: "unscoped" }
                : { ctxId, kind: "context" };
        const mapKey =
            key.kind === "unscoped" ? "unscoped:" : `context:${key.ctxId}`;
        const existing = contexts.get(mapKey);
        if (existing !== undefined) return existing;
        const created: MutableAuditContext = {
            approvals: [],
            calls: [],
            key,
            label: key.kind === "unscoped" ? "unscoped" : key.ctxId,
        };
        contexts.set(mapKey, created);
        return created;
    };

    const callsById = new Map(
        (state.readModel.instanceState[instance]?.toolCalls ?? []).map((call) => [call.callId, call] as const),
    );
    for (const call of state.readModel.instanceState[instance]?.commentCalls ?? []) {
        callsById.set(call.callId, call);
    }
    for (const call of callsById.values()) {
        resolve(call.ctxId).calls.push(call);
    }
    for (const approval of state.readModel.instanceState[instance]?.approvals ?? []) {
        resolve(approval.ctxId).approvals.push(approval);
    }
    return [...contexts.values()]
        .map((context) => toSummary(context, state, instance))
        .sort((left, right) =>
            right.latestActivityAt.localeCompare(left.latestActivityAt),
        );
}

export function findAuditContext(
    state: TuiAppState,
    instance: string,
    key: TuiAuditContextKey,
): TuiAuditContextSummary | undefined {
    return projectAuditContexts(state, instance).find((context) =>
        key.kind === "unscoped"
            ? context.key.kind === "unscoped"
            : context.key.kind === "context" && context.key.ctxId === key.ctxId,
    );
}

function toSummary(
    context: MutableAuditContext,
    state: TuiAppState,
    instance: string,
): TuiAuditContextSummary {
    const sortedCalls = [...context.calls].sort((left, right) =>
        left.startedAt.localeCompare(right.startedAt),
    );
    const latestCall = sortedCalls.at(-1);
    const latestActivityAt =
        [
            ...sortedCalls.map((call) => call.completedAt ?? call.startedAt),
            ...context.approvals.map((approval) => approval.createdAt),
        ]
            .sort()
            .at(-1) ?? "-";
    const ctxId = context.key.kind === "context" ? context.key.ctxId : undefined;
    const registryStatus = ctxId === undefined
        ? undefined
        : state.readModel.contexts.find(
              (record) =>
                  record.ctxId === ctxId &&
                  record.instance === instance,
          )?.status;

    return {
        approvals: [...context.approvals].sort((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
        ),
        calls: sortedCalls,
        contextStatus: registryStatus,
        key: context.key,
        label: context.label,
        latestActivityAt,
        latestCall,
        status: contextStatus(sortedCalls, context.approvals),
    };
}

function contextStatus(
    calls: readonly ToolCallRecord[],
    approvals: readonly ApprovalRequest[],
): TuiExpandableBoxStatus {
    if (calls.some((call) => toolCallOutcome(call.status) === "failure")) return "failed";
    if (approvals.some((approval) => approval.status === "pending")) return "pending";
    if (calls.some((call) => toolCallOutcome(call.status) === "pending")) return "running";
    return calls.length === 0 ? "normal" : "ready";
}
