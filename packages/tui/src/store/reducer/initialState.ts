import { createEmptyInteractionState } from "../../interaction/TuiInteractionTypes.js";
import type { TuiAppState } from "./types.js";

export function createInitialTuiAppState(): TuiAppState {
    return {
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
            mainFocusId: undefined,
            scrollOffsets: {},
            searchQueries: {},
            selectedInstance: undefined,
            selectedPage: "instances",
            sidebarFocus: "pages"
        }
    };
}
