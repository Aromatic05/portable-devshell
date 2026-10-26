import {
    toolCallOutcome,
    type ApprovalRequest,
    type ContextStatus,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import type { TuiExpandableBoxStatus } from "../Ui.js";
import type { TuiDomainReader } from "../../app/control/Reader.js";

export type TuiAuditContextKey =
    | { readonly kind: "unscoped" }
    | { readonly ctxId: string; readonly kind: "context" };

export interface TuiAuditContextSummary {
    readonly approvals: readonly ApprovalRequest[];
    readonly calls: readonly ToolCallRecord[];
    readonly contextStatus?: ContextStatus;
    readonly key: TuiAuditContextKey;
    readonly label: string;
    readonly latestActivityAt: string;
    readonly latestCall?: ToolCallRecord;
    readonly status: TuiExpandableBoxStatus;
    readonly workspace?: string;
}

interface MutableAuditContext {
    approvals: ApprovalRequest[];
    calls: ToolCallRecord[];
    key: TuiAuditContextKey;
    label: string;
}

let auditProjectionCache:
    | {
          approvals: readonly ApprovalRequest[];
          contexts: TuiDomainReader["context"]["contexts"];
          instance: string;
          result: TuiAuditContextSummary[];
          contextHistory: TuiDomainReader["toolCalls"]["context"];
          toolCalls: readonly ToolCallRecord[];
      }
    | undefined;

export function projectAuditContexts(
    reader: TuiDomainReader,
    instance: string,
): TuiAuditContextSummary[] {
    const toolCalls = reader.toolCalls.instances[instance]?.calls ?? [];
    const contextHistory = reader.toolCalls.context;
    const approvals = reader.approval(instance).approvals;
    const contexts = reader.context.contexts;
    if (
        auditProjectionCache?.instance === instance &&
        auditProjectionCache.contexts === contexts &&
        auditProjectionCache.contextHistory === contextHistory &&
        auditProjectionCache.toolCalls === toolCalls &&
        auditProjectionCache.approvals === approvals
    )
        return auditProjectionCache.result;
    const contextMap = new Map<string, MutableAuditContext>();
    const resolve = (ctxId: string | undefined): MutableAuditContext => {
        const key: TuiAuditContextKey =
            ctxId === undefined || ctxId.length === 0
                ? { kind: "unscoped" }
                : { ctxId, kind: "context" };
        const mapKey =
            key.kind === "unscoped" ? "unscoped:" : `context:${key.ctxId}`;
        const existing = contextMap.get(mapKey);
        if (existing !== undefined) return existing;
        const created: MutableAuditContext = {
            approvals: [],
            calls: [],
            key,
            label: key.kind === "unscoped" ? "unscoped" : key.ctxId,
        };
        contextMap.set(mapKey, created);
        return created;
    };

    for (const call of toolCalls) {
        resolve(call.ctxId).calls.push(call);
    }
    // Wait for the first instance ledger read before exposing registry-only
    // entries. Otherwise the sidebar becomes navigable during route hydration.
    if (reader.toolCalls.instances[instance] !== undefined) {
        for (const record of contexts) {
            if (record.environments.some((environment) => environment.instance === instance))
                resolve(record.ctxId);
        }
    }
    if (contextHistory?.instance === instance)
        resolve(contextHistory.ctxId).calls = [...contextHistory.calls];
    for (const approval of approvals) {
        if (approval.recording === "caller") continue;
        resolve(approval.ctxId).approvals.push(approval);
    }
    const result = [...contextMap.values()]
        .map((context) => toSummary(context, reader, instance))
        .sort((left, right) =>
            right.latestActivityAt.localeCompare(left.latestActivityAt),
        );
    auditProjectionCache = {
        approvals,
        contexts,
        contextHistory,
        instance,
        result,
        toolCalls,
    };
    return result;
}

export function findAuditContext(
    reader: TuiDomainReader,
    instance: string,
    key: TuiAuditContextKey,
): TuiAuditContextSummary | undefined {
    return projectAuditContexts(reader, instance).find((context) =>
        key.kind === "unscoped"
            ? context.key.kind === "unscoped"
            : context.key.kind === "context" && context.key.ctxId === key.ctxId,
    );
}

function toSummary(
    context: MutableAuditContext,
    reader: TuiDomainReader,
    instance: string,
): TuiAuditContextSummary {
    const sortedCalls = [...context.calls].sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt),
    );
    const latestCall = sortedCalls[0];
    const latestActivityAt =
        [
            ...sortedCalls.map((call) => call.completedAt ?? call.startedAt),
            ...context.approvals.map((approval) => approval.createdAt),
        ]
            .sort()
            .at(-1) ?? "-";
    const ctxId =
        context.key.kind === "context" ? context.key.ctxId : undefined;
    const registryRecord =
        ctxId === undefined
            ? undefined
            : reader.context.contexts.find((record) => record.ctxId === ctxId);
    const environment =
        registryRecord === undefined
            ? undefined
            : (
                  registryRecord.environments
              ).find((candidate) => candidate.instance === instance);
    const latestApproval = [...context.approvals].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
    )[0];

    return {
        approvals: [...context.approvals].sort((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
        ),
        calls: sortedCalls,
        contextStatus:
            environment === undefined ? undefined : registryRecord?.status,
        key: context.key,
        label: context.label,
        latestActivityAt,
        latestCall,
        status: contextStatus(sortedCalls, context.approvals),
        workspace:
            environment?.workspace ??
            latestCall?.workspace ??
            latestApproval?.workspace,
    };
}

function contextStatus(
    calls: readonly ToolCallRecord[],
    approvals: readonly ApprovalRequest[],
): TuiExpandableBoxStatus {
    if (calls.some((call) => toolCallOutcome(call.status) === "failure"))
        return "failed";
    if (approvals.some((approval) => approval.status === "pending"))
        return "pending";
    if (calls.some((call) => toolCallOutcome(call.status) === "pending"))
        return "running";
    return calls.length === 0 ? "normal" : "ready";
}
