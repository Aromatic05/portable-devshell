import { createInitialControlReadModelState } from "@portable-devshell/shared";
import { createEmptyInteractionState } from "../TuiInteractionState.js";
import type { TuiAppState } from "./TuiStoreModel.js";

export function createInitialTuiAppState(): TuiAppState {
    return {
        commandRecords: [],
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
        lastStatusChangeAtByInstance: {},
        panelErrors: {},
        rawEvents: [],
        readModel: createInitialControlReadModelState(),
        relayByCommand: {},
        ui: {
            controlRestartRequired: false,
            dirtyForms: {},
            expandedBoxes: {},
            formDrafts: {},
            logsClearedThroughSeqByInstance: {},
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
