import type { JsonValue } from "@portable-devshell/shared";

import type { TuiAppState } from "./TuiStoreModel.js";

export function selectInstanceAfterListReplace(state: TuiAppState): TuiAppState {
    const names = new Set(state.instances.map((instance) => instance.name));
    const selectedInstance =
        state.ui.selectedInstance !== undefined && names.has(state.ui.selectedInstance)
            ? state.ui.selectedInstance
            : state.instances[0]?.name;
    return {
        ...state,
        ui: { ...state.ui, selectedInstance },
    };
}

export function withDerivedState(state: TuiAppState): TuiAppState {
    const pendingApprovalCount = Object.values(state.approvalsByInstance).reduce(
        (count, approvals) =>
            count + approvals.filter((approval) => approval.status === "pending").length,
        0,
    );
    return {
        ...state,
        globalDerived: {
            connectedInstanceCount: Object.values(state.snapshotsByInstance).filter(
                (snapshot) => snapshot.connectionState === "connected",
            ).length,
            pendingApprovalCount,
            totalEventCount: state.rawEvents.length,
        },
    };
}

export function asRecord(
    value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
