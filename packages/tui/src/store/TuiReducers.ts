import type { ControlEventEnvelope, InstanceSnapshot, JsonValue } from "@portable-devshell/shared";

import {
    createEmptyInteractionState,
    type FocusItem,
    type TuiActionMenuItem,
    type TuiInteractionState,
    type TuiMode,
    type TuiUiIntent
} from "../interaction/TuiInteractionTypes.js";

export type TuiPanel = "instances" | "config" | "connector" | "audit" | "logs" | "help";
export type TuiConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface TuiInstanceListEntry {
    mcpEnabled: boolean;
    name: string;
}

export interface TuiConnectionState {
    errorCode?: string;
    errorMessage?: string;
    status: TuiConnectionStatus;
}

export interface TuiRawEventRecord {
    event: string;
    instance: string;
    payload?: JsonValue;
    seq: number;
}

export interface TuiGlobalDerivedState {
    connectedInstanceCount: number;
    totalEventCount: number;
}

export interface TuiAppState {
    activePanel: TuiPanel;
    configView?: Record<string, JsonValue>;
    connection: TuiConnectionState;
    globalDerived: TuiGlobalDerivedState;
    interaction: TuiInteractionState;
    instances: TuiInstanceListEntry[];
    lastSeqByInstance: Record<string, number>;
    rawEvents: TuiRawEventRecord[];
    snapshotsByInstance: Record<string, InstanceSnapshot>;
}

export type TuiAppAction =
    | { panel: TuiPanel; type: "panel.setActive" }
    | { configView?: Record<string, JsonValue>; type: "control.setConfigView" }
    | { errorCode?: string; errorMessage?: string; status: TuiConnectionStatus; type: "control.setConnectionState" }
    | { item?: FocusItem; type: "focus.setCurrent" }
    | { instance: string; seq: number; type: "instance.setLastSeq" }
    | { instances: TuiInstanceListEntry[]; type: "instance.replaceList" }
    | { items: TuiActionMenuItem[]; selectedIndex: number; title: string; type: "overlay.setActionMenu" }
    | { confirmIntent: TuiUiIntent; body: string; cancelLabel: string; confirmLabel: string; open: boolean; title: string; type: "overlay.setConfirmDialog" }
    | { value: boolean; type: "interaction.setDirty" }
    | { mode: TuiMode; type: "mode.set" }
    | { query: string; type: "search.setQuery" }
    | { type: "search.setOpen"; value: boolean }
    | { panel: TuiPanel; status?: string; type: "screen.setStatus" }
    | { panel: TuiPanel; type: "screen.setToggle"; value: boolean }
    | { type: "ui.bumpRedrawNonce" }
    | { maxEvents?: number; rawEvent: TuiRawEventRecord; type: "event.append" }
    | { snapshot: InstanceSnapshot; type: "snapshot.replace" };

export function createInitialTuiAppState(): TuiAppState {
    return {
        activePanel: "instances",
        connection: {
            status: "connecting"
        },
        globalDerived: {
            connectedInstanceCount: 0,
            totalEventCount: 0
        },
        interaction: createEmptyInteractionState(),
        instances: [],
        lastSeqByInstance: {},
        rawEvents: [],
        snapshotsByInstance: {}
    };
}

export function tuiAppReducer(state: TuiAppState, action: TuiAppAction): TuiAppState {
    switch (action.type) {
        case "panel.setActive":
            return {
                ...state,
                activePanel: action.panel
            };
        case "control.setConfigView":
            return {
                ...state,
                configView: action.configView
            };
        case "control.setConnectionState":
            return {
                ...state,
                connection: {
                    errorCode: action.errorCode,
                    errorMessage: action.errorMessage,
                    status: action.status
                }
            };
        case "focus.setCurrent":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    currentFocus: action.item
                }
            };
        case "instance.replaceList":
            return withDerivedState({
                ...state,
                instances: [...action.instances]
            });
        case "overlay.setActionMenu":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    actionMenu: {
                        items: [...action.items],
                        open: action.items.length > 0,
                        selectedIndex: action.selectedIndex,
                        title: action.title
                    }
                }
            };
        case "overlay.setConfirmDialog":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    confirmDialog: {
                        body: action.body,
                        cancelLabel: action.cancelLabel,
                        confirmIntent: action.confirmIntent,
                        confirmLabel: action.confirmLabel,
                        open: action.open,
                        title: action.title
                    }
                }
            };
        case "interaction.setDirty":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    dirty: action.value
                }
            };
        case "mode.set":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    mode: action.mode
                }
            };
        case "search.setQuery":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    search: {
                        ...state.interaction.search,
                        query: action.query
                    }
                }
            };
        case "search.setOpen":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    search: {
                        ...state.interaction.search,
                        open: action.value
                    }
                }
            };
        case "screen.setStatus":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    screenStatusByPanel:
                        action.status === undefined
                            ? Object.fromEntries(
                                  Object.entries(state.interaction.screenStatusByPanel).filter(([panel]) => panel !== action.panel)
                              )
                            : {
                                  ...state.interaction.screenStatusByPanel,
                                  [action.panel]: action.status
                              }
                }
            };
        case "screen.setToggle":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    screenToggleByPanel: {
                        ...state.interaction.screenToggleByPanel,
                        [action.panel]: action.value
                    }
                }
            };
        case "ui.bumpRedrawNonce":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    redrawNonce: state.interaction.redrawNonce + 1
                }
            };
        case "snapshot.replace": {
            const instance = action.snapshot.name;
            return withDerivedState({
                ...state,
                lastSeqByInstance: {
                    ...state.lastSeqByInstance,
                    [instance]: action.snapshot.lastSeq
                },
                snapshotsByInstance: {
                    ...state.snapshotsByInstance,
                    [instance]: action.snapshot
                }
            });
        }
        case "instance.setLastSeq":
            if ((state.lastSeqByInstance[action.instance] ?? 0) >= action.seq) {
                return state;
            }

            return {
                ...state,
                lastSeqByInstance: {
                    ...state.lastSeqByInstance,
                    [action.instance]: action.seq
                }
            };
        case "event.append": {
            const rawEvents = [...state.rawEvents, action.rawEvent];
            const maxEvents = action.maxEvents ?? 100;

            return withDerivedState({
                ...state,
                lastSeqByInstance:
                    (state.lastSeqByInstance[action.rawEvent.instance] ?? 0) >= action.rawEvent.seq
                        ? state.lastSeqByInstance
                        : {
                              ...state.lastSeqByInstance,
                              [action.rawEvent.instance]: action.rawEvent.seq
                          },
                rawEvents: rawEvents.slice(Math.max(0, rawEvents.length - maxEvents))
            });
        }
    }
}

export function toRawEventRecord(envelope: ControlEventEnvelope): TuiRawEventRecord {
    return {
        event: envelope.event,
        instance: envelope.target.instance,
        payload: envelope.payload,
        seq: envelope.seq
    };
}

function withDerivedState(state: TuiAppState): TuiAppState {
    return {
        ...state,
        globalDerived: {
            connectedInstanceCount: Object.values(state.snapshotsByInstance).filter((snapshot) => snapshot.connectionState === "connected").length,
            totalEventCount: state.rawEvents.length
        }
    };
}
