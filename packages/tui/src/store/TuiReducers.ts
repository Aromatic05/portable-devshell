import type { ControlEventEnvelope, InstanceSnapshot, JsonValue } from "@portable-devshell/shared";

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
    instances: TuiInstanceListEntry[];
    lastSeqByInstance: Record<string, number>;
    rawEvents: TuiRawEventRecord[];
    snapshotsByInstance: Record<string, InstanceSnapshot>;
}

export type TuiAppAction =
    | { panel: TuiPanel; type: "panel.setActive" }
    | { configView?: Record<string, JsonValue>; type: "control.setConfigView" }
    | { errorCode?: string; errorMessage?: string; status: TuiConnectionStatus; type: "control.setConnectionState" }
    | { instance: string; seq: number; type: "instance.setLastSeq" }
    | { instances: TuiInstanceListEntry[]; type: "instance.replaceList" }
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
        case "instance.replaceList":
            return withDerivedState({
                ...state,
                instances: [...action.instances]
            });
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
