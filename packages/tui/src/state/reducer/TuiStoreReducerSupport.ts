import type { JsonValue } from "@portable-devshell/shared";

import type { TuiAppState } from "./TuiStoreModel.js";

export function selectInstanceAfterListReplace(state: TuiAppState): TuiAppState {
    const names = new Set(state.instances.map((instance) => instance.name));
    const selectedInstance =
        state.ui.selectedInstance !== undefined && names.has(state.ui.selectedInstance)
            ? state.ui.selectedInstance
            : state.instances[0]?.name;
    return selectedInstance === state.ui.selectedInstance
        ? state
        : { ...state, ui: { ...state.ui, selectedInstance } };
}

export function withDerivedState(state: TuiAppState): TuiAppState {
    const instanceStates = Object.values(state.readModel.instanceState);
    const pendingToolApprovalCount = instanceStates.reduce(
        (count, instance) => count + instance.approvals.filter((approval) => approval.status === "pending").length,
        0,
    );
    const pendingOAuthApprovalCount = state.readModel.oauthApprovals.filter(
        (approval) => approval.status === "pending",
    ).length;
    return {
        ...state,
        globalDerived: {
            connectedInstanceCount: instanceStates.filter(
                (instance) => instance.snapshot?.connectionState === "connected",
            ).length,
            pendingApprovalCount: pendingToolApprovalCount + pendingOAuthApprovalCount,
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
