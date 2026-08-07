import type {
    ControlError,
    ControlInstanceReadState,
    ControlReadModelState,
    InstanceEvent,
    InstanceLogEntry,
    JsonValue,
} from "@portable-devshell/shared";

import type {
    TuiEditorState,
    TuiInteractionState,
} from "../TuiInteractionState.js";
import type { TuiOverlay } from "../overlay/TuiOverlay.js";
import type { TuiRoute } from "../route/TuiRoute.js";
import type {
    TuiFocusScope,
    TuiPageId,
    TuiSidebarCursor,
    TuiSidebarFocus,
    TuiUiState,
} from "../TuiUiState.js";

export type TuiConnectionStatus =
    "connecting" | "connected" | "disconnected" | "error";

export interface TuiInstanceListEntry {
    defaultWorkspace?: string;
    enabled: boolean;
    mcpEnabled: boolean;
    mcpPath?: string;
    name: string;
    provider?: string;
}

export type TuiLogEntry = InstanceLogEntry;

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
    pendingApprovalCount: number;
    totalEventCount: number;
}

export interface TuiCommandRecord {
    commandId: string;
    completedAt?: string;
    error?: ControlError;
    sourcePanel: string;
    startedAt: string;
    status: "running" | "succeeded" | "failed";
    targetInstance?: string;
    title: string;
}

export interface TuiRelayRecord {
    commandId: string;
    output: string[];
    provider?: string;
    requestId?: string;
    workspace?: string;
}

export interface TuiAppState {
    commandRecords: TuiCommandRecord[];
    connection: TuiConnectionState;
    globalDerived: TuiGlobalDerivedState;
    interaction: TuiInteractionState;
    instances: TuiInstanceListEntry[];
    lastStatusChangeAtByInstance: Record<string, string>;
    panelErrors: Record<string, ControlError>;
    rawEvents: TuiRawEventRecord[];
    readModel: ControlReadModelState;
    relayByCommand: Record<string, TuiRelayRecord>;
    ui: TuiUiState;
}

export type TuiControlReadModelPatch = Partial<Omit<ControlReadModelState, "instanceState" | "instances">> & {
    instanceState?: Record<string, Partial<ControlInstanceReadState>>;
    instances?: TuiInstanceListEntry[];
};

export type TuiAppAction =
    | { instances: TuiInstanceListEntry[]; readModel: ControlReadModelState; type: "control.readModel.replace" }
    | { command: TuiCommandRecord; type: "command.upsert" }
    | { error?: ControlError; key: string; type: "panelError.set" }
    | { commandId: string; chunk: string; type: "relay.appendOutput" }
    | {
          commandId: string;
          provider?: string;
          requestId?: string;
          workspace?: string;
          type: "relay.setMetadata";
      }
    | {
          errorCode?: string;
          errorMessage?: string;
          status: TuiConnectionStatus;
          type: "control.setConnectionState";
      }
    | { focusScope: TuiFocusScope; type: "focus.scope.set" }
    | { type: "log.clearBuffer" }
    | { mainFocusId?: string; type: "mainFocus.set" }
    | { key: string; lineId?: string; type: "detailLine.select" }
    | { cursor?: TuiSidebarCursor; type: "sidebar.cursor.set" }
    | { sidebarFocus: TuiSidebarFocus; type: "sidebar.focus.set" }
    | { page: TuiPageId; query: string; type: "search.setQuery" }
    | { editor?: TuiEditorState; type: "editor.set" }
    | { dirty: boolean; key: string; value: unknown; type: "formDraft.set" }
    | { key: string; type: "formDraft.clear" }
    | { page: TuiPageId; status?: string; type: "screen.setStatus" }
    | { instance?: string; type: "ui.selectInstance" }
    | { page: TuiPageId; type: "ui.selectPage" }
    | { overlay: TuiOverlay; type: "overlay.push" }
    | { overlay: TuiOverlay; type: "overlay.replaceTop" }
    | { type: "overlay.pop" }
    | { route: TuiRoute; type: "route.push" }
    | { type: "route.pop" }
    | { route: TuiRoute; type: "route.replace" }
    | { type: "route.reset" }
    | { key: string; type: "ui.toggleExpanded" }
    | { key: string; offset: number; type: "ui.setScrollOffset" }
    | { follow: boolean; instance: string; type: "logs.setFollow" }
    | { instance: string; seq?: number; type: "logs.setPausedAtSeq" }
    | { required: boolean; type: "control.setRestartRequired" }
    | { type: "ui.bumpRedrawNonce" }
    | { maxEvents?: number; rawEvent: TuiRawEventRecord; type: "event.append" };

export function toRawEventRecord(event: InstanceEvent): TuiRawEventRecord {
    return {
        event: event.type,
        instance: event.instanceName,
        payload: event as unknown as JsonValue,
        seq: event.seq,
    };
}

export function selectTuiLogs(state: TuiAppState, instance: string): InstanceLogEntry[] {
    const throughSeq = state.ui.logsClearedThroughSeqByInstance[instance] ?? 0;
    return (state.readModel.instanceState[instance]?.logs ?? []).filter(
        (entry) => entry.seq > throughSeq,
    );
}
