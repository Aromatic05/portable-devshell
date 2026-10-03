import type {
    RemoteError,
    InstanceEvent,
    InstanceLogEntry,
    JsonValue,
} from "@portable-devshell/shared";

import type { TuiEditorState, TuiInteractionState } from "../Interaction.js";
import type { TuiOverlay } from "../Overlay.js";
import type { TuiRoute } from "../route/Model.js";
import type {
    TuiFocusScope,
    TuiMessageScope,
    TuiPageId,
    TuiSidebarCursor,
    TuiSidebarFocus,
    TuiUiState,
} from "../Ui.js";

export type TuiConnectionStatus =
    "connecting" | "connected" | "disconnected" | "error";

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

export interface TuiCommandRecord {
    commandId: string;
    completedAt?: string;
    error?: RemoteError;
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
}

/**
 * UI-local state only. Remote domain snapshots live in their view models and
 * never get copied here; the store only carries local interaction state plus
 * local diagnostics (connection indicator, command records, panel errors, and
 * the raw event log).
 */
export interface TuiAppState {
    commandRecords: TuiCommandRecord[];
    connection: TuiConnectionState;
    interaction: TuiInteractionState;
    panelErrors: Record<string, RemoteError>;
    rawEvents: TuiRawEventRecord[];
    relayByCommand: Record<string, TuiRelayRecord>;
    ui: TuiUiState;
}

export type TuiAppAction =
    | { command: TuiCommandRecord; type: "command.upsert" }
    | { error?: RemoteError; key: string; type: "panelError.set" }
    | { commandId: string; chunk: string; type: "relay.appendOutput" }
    | {
          commandId: string;
          provider?: string;
          requestId?: string;
          type: "relay.setMetadata";
      }
    | {
          errorCode?: string;
          errorMessage?: string;
          status: TuiConnectionStatus;
          type: "control.setConnectionState";
      }
    | { focusScope: TuiFocusScope; type: "focus.scope.set" }
    | { mainFocusId?: string; type: "mainFocus.set" }
    | { type: "messages.project.toggle"; workspaceKey: string }
    | { scope: TuiMessageScope; type: "messages.scope.set" }
    | { key: string; lineId?: string; type: "detailLine.select" }
    | { cursor?: TuiSidebarCursor; type: "sidebar.cursor.set" }
    | { sidebarFocus: TuiSidebarFocus; type: "sidebar.focus.set" }
    | { level: TuiUiState["sidebarLevel"]; type: "sidebar.level.set" }
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