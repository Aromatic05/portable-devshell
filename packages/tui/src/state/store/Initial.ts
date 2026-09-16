import {
    createEmptyConversationPreferences,
    createInitialControlReadModelState,
} from "@portable-devshell/shared";
import { createEmptyInteractionState } from "../Interaction.js";
import type { TuiAppState } from "./Model.js";

export function createInitialTuiAppState(): TuiAppState {
    return {
        commandRecords: [],
        connection: {
            status: "connecting",
        },
        conversationPreferences: createEmptyConversationPreferences(),
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
