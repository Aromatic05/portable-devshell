import { createEmptyInteractionState } from "../TuiInteractionState.js";
import type { TuiAppState } from "./TuiStoreModel.js";

export function createInitialTuiAppState(): TuiAppState {
    return {
        artifactShares: [],
        artifactTransfers: [],
        approvalsByInstance: {},
        commandRecords: [],
        contextMessagesByInstance: {},
        connection: {
            status: "connecting",
        },
        globalDerived: {
            connectedInstanceCount: 0,
            pendingApprovalCount: 0,
            totalEventCount: 0,
        },
        interaction: createEmptyInteractionState(),
        instances: [],
        lastSeqByInstance: {},
        lastStatusChangeAtByInstance: {},
        logsByInstance: {},
        oauthApprovals: [],
        panelErrors: {},
        rawEvents: [],
        relayByCommand: {},
        snapshotsByInstance: {},
        todoByInstance: {},
        toolCallsByInstance: {},
        ui: {
            controlRestartRequired: false,
            dirtyForms: {},
            expandedBoxes: {},
            formDrafts: {},
            logsFollowByInstance: {},
            logsPausedAtSeqByInstance: {},
            mainFocusId: undefined,
            routeStacks: {},
            routeViewStates: {},
            scrollOffsets: {},
            searchQueries: {},
            selectedInstance: undefined,
            selectedPage: "instances",
            sidebarFocus: "pages",
        },
    };
}
