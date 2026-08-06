import type {
    ApprovalRequest,
    ToolCallRecord,
} from "@portable-devshell/shared";

import type { TuiAppState } from "../reducer/TuiStoreModel.js";

export function latestObservedContextId(
    state: TuiAppState,
    instance: string,
): string | undefined {
    const calls = new Map<string, ToolCallRecord>();
    for (const call of state.toolCallsByInstance[instance] ?? []) {
        calls.set(call.callId, call);
    }
    for (const call of state.commentCallsByInstance[instance] ?? []) {
        calls.set(call.callId, call);
    }
    const activities = [
        ...[...calls.values()].flatMap(callActivity),
        ...(state.approvalsByInstance[instance] ?? []).flatMap(approvalActivity),
    ];
    return activities.sort((left, right) => right.at.localeCompare(left.at))[0]
        ?.ctxId;
}

export function isLatestObservedContext(
    state: TuiAppState,
    instance: string,
    ctxId: string,
): boolean {
    const latest = latestObservedContextId(state, instance);
    return latest === undefined || latest === ctxId;
}

function callActivity(
    call: ToolCallRecord,
): Array<{ at: string; ctxId: string }> {
    return typeof call.ctxId === "string" && call.ctxId.length > 0
        ? [{ at: call.startedAt, ctxId: call.ctxId }]
        : [];
}

function approvalActivity(
    approval: ApprovalRequest,
): Array<{ at: string; ctxId: string }> {
    return typeof approval.ctxId === "string" && approval.ctxId.length > 0
        ? [{ at: approval.createdAt, ctxId: approval.ctxId }]
        : [];
}
