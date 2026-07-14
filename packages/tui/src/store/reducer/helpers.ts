import type { ApprovalRequest, JsonValue, ToolCallRecord } from "@portable-devshell/shared";

import type { TuiAppState, TuiInstanceListEntry, TuiLogEntry } from "./types.js";

export function selectInstanceAfterListReplace(state: TuiAppState): TuiAppState {
    const names = new Set(state.instances.map((instance) => instance.name));
    const selectedInstance =
        state.ui.selectedInstance !== undefined && names.has(state.ui.selectedInstance)
            ? state.ui.selectedInstance
            : state.instances[0]?.name;

    return {
        ...state,
        ui: {
            ...state.ui,
            selectedInstance
        }
    };
}

export function withDerivedState(state: TuiAppState): TuiAppState {
    const pendingApprovalCount = Object.values(state.approvalsByInstance).reduce(
        (count, approvals) => count + approvals.filter((approval) => approval.status === "pending").length,
        0
    );

    return {
        ...state,
        globalDerived: {
            connectedInstanceCount: Object.values(state.snapshotsByInstance).filter((snapshot) => snapshot.connectionState === "connected").length,
            pendingApprovalCount,
            totalEventCount: state.rawEvents.length
        }
    };
}

export function isStatusEvent(event: string): boolean {
    return event === "instance.statusChanged" || event === "instance.connectionChanged" || event === "instance.readyChanged";
}

export function isToolCallEvent(event: string): boolean {
    return (
        event === "toolCall.queued" ||
        event === "toolCall.pendingApproval" ||
        event === "toolCall.running" ||
        event === "toolCall.completed" ||
        event === "toolCall.failed" ||
        event === "toolCall.denied" ||
        event === "toolCall.expired"
        || event === "toolCall.queueTimeout"
        || event === "toolCall.cancelled"
    );
}

export function isApprovalEvent(event: string): boolean {
    return event === "approval.requested" || event === "approval.approved" || event === "approval.denied" || event === "approval.expired" || event === "approval.cancelled";
}

export function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

export function compareToolCallRecord(left: ToolCallRecord, right: ToolCallRecord): number {
    const startedAt = right.startedAt.localeCompare(left.startedAt);

    if (startedAt !== 0) {
        return startedAt;
    }

    return right.callId.localeCompare(left.callId);
}

export function upsertToolCall(current: ToolCallRecord[], next: ToolCallRecord): ToolCallRecord[] {
    const without = current.filter((record) => record.callId !== next.callId);
    return [...without, next].sort(compareToolCallRecord);
}

export function upsertApproval(current: ApprovalRequest[], next: ApprovalRequest): ApprovalRequest[] {
    const without = current.filter((approval) => approval.approvalId !== next.approvalId);
    return [...without, next].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function mergeLogEntry(current: TuiLogEntry[], next: TuiLogEntry): TuiLogEntry[] {
    return dedupeLogs([...current.filter((entry) => entry.seq !== next.seq), next]);
}

export function dedupeLogs(logs: TuiLogEntry[]): TuiLogEntry[] {
    return [...logs]
        .sort((left, right) => {
            if (left.instance !== right.instance) {
                return left.instance.localeCompare(right.instance);
            }

            return left.seq - right.seq;
        })
        .filter((entry, index, entries) => index === 0 || !(entries[index - 1]?.instance === entry.instance && entries[index - 1]?.seq === entry.seq));
}

export function pruneByInstances<T>(value: Record<string, T>, instances: TuiInstanceListEntry[]): Record<string, T> {
    const nextNames = new Set(instances.map((instance) => instance.name));
    return Object.fromEntries(Object.entries(value).filter(([name]) => nextNames.has(name)));
}

export function pruneByInstanceNames<T extends string | number>(value: Record<string, T>, instances: TuiInstanceListEntry[]): Record<string, T> {
    const nextNames = new Set(instances.map((instance) => instance.name));
    return Object.fromEntries(Object.entries(value).filter(([name]) => nextNames.has(name)));
}
