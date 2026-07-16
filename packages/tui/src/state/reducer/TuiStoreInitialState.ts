import { createEmptyInteractionState } from "../TuiInteractionState.js";
import type { TuiAppState } from "./TuiStoreModel.js";

export function createInitialTuiAppState(): TuiAppState {
    return {
        artifactShares: [],
        artifactTransfers: [],
        approvalsByInstance: {},
        commandRecords: [],
        connection: {
            status: "connecting"
        },
        globalDerived: {
            connectedInstanceCount: 0,
            pendingApprovalCount: 0,
            totalEventCount: 0
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
            focusScope: "sidebarPages",
            formDrafts: {},
            logsFollowByInstance: {},
            logsPausedAtSeqByInstance: {},
            mainFocusId: undefined,
            scrollOffsets: {},
            searchQueries: {},
            selectedInstance: undefined,
            selectedPage: "instances",
            sidebarFocus: "pages"
        }
    };
}
