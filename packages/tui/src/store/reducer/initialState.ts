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
        toolCallsByInstance: {},
        ui: {
            dirtyForms: {},
            expandedBoxes: {},
            focusScope: "sidebarPages",
            formDrafts: {},
            mainFocusId: undefined,
            scrollOffsets: {},
            searchQueries: {},
            selectedInstance: undefined,
            selectedPage: "instances",
            sidebarFocus: "pages"
        }
    };
}
