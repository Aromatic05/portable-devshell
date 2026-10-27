import { createEmptyInteractionState } from "../Interaction.js";
import type { TuiAppState } from "./Model.js";

export function createInitialTuiAppState(): TuiAppState {
    return {
        commandRecords: [],
        connection: {
            status: "connecting",
        },
        interaction: createEmptyInteractionState(),
        panelErrors: {},
        rawEvents: [],
        relayByCommand: {},
        ui: {
            controlRestartRequired: false,
            dirtyForms: {},
            expandedBoxes: {},
            formDrafts: {},
            formDraftBaselines: {},
            mainFocusId: undefined,
            messageCollapsedWorkspaces: {},
            messageScope: "active",
            routeStacks: {},
            routeViewStates: {},
            scrollOffsets: {},
            searchQueries: {},
            selectedInstance: undefined,
            selectedPage: "instances",
            sidebarFocus: "context",
            sidebarLevel: "root",
        },
    };
}