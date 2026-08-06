import type {
    ApprovalRequest,
    ArtifactShareResult,
    ArtifactTransferRecord,
    ClientEvent,
    InstanceEvent,
    ContextMessageRecord,
    ControlError,
    InstanceSnapshot,
    JsonValue,
    OAuthApprovalRequest,
    OperationalOverview,
    TodoReadResult,
    ToolCallRecord,
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

export interface TuiLogEntry {
    at?: string;
    bytes?: number;
    callId?: string;
    instance: string;
    message?: string;
    preview?: string;
    receivedAt: string;
    requestId?: string;
    seq: number;
    ctxId?: string;
    source?: "cli" | "tui" | "web" | "mcp";
    stream: "stderr" | "stdout";
    tail?: string;
    toolName?: string;
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
    artifactShares: ArtifactShareResult[];
    artifactTransfers: ArtifactTransferRecord[];
    approvalsByInstance: Record<string, ApprovalRequest[]>;
    commandRecords: TuiCommandRecord[];
    commentCallsByInstance: Record<string, ToolCallRecord[]>;
    contextMessagesByInstance: Record<string, ContextMessageRecord[]>;
    configView?: Record<string, JsonValue>;
    connection: TuiConnectionState;
    globalDerived: TuiGlobalDerivedState;
    interaction: TuiInteractionState;
    instances: TuiInstanceListEntry[];
    lastSeqByInstance: Record<string, number>;
    lastStatusChangeAtByInstance: Record<string, string>;
    logsByInstance: Record<string, TuiLogEntry[]>;
    mcpStatus?: McpRuntimeStatus;
    oauthApprovals: OAuthApprovalRequest[];
    operationalOverview?: OperationalOverview;
    rawEvents: TuiRawEventRecord[];
    panelErrors: Record<string, ControlError>;
    relayByCommand: Record<string, TuiRelayRecord>;
    snapshotsByInstance: Record<string, InstanceSnapshot>;
    todoByInstance: Record<string, TodoReadResult>;
    toolCallsByInstance: Record<string, ToolCallRecord[]>;
    ui: TuiUiState;
}

export type TuiAppAction =
    | { shares: ArtifactShareResult[]; type: "artifact.share.replace" }
    | { share: ArtifactShareResult; type: "artifact.share.upsert" }
    | { transfers: ArtifactTransferRecord[]; type: "artifact.transfer.replace" }
    | { transfer: ArtifactTransferRecord; type: "artifact.transfer.upsert" }
    | {
          approvals: ApprovalRequest[];
          instance: string;
          type: "approval.replace";
      }
    | { approvals: OAuthApprovalRequest[]; type: "oauthApproval.replace" }
    | { overview?: OperationalOverview; type: "overview.replace" }
    | { instance: string; records: ToolCallRecord[]; type: "commentCall.replace" }
    | { command: TuiCommandRecord; type: "command.upsert" }
    | {
          instance: string;
          messages: ContextMessageRecord[];
          type: "contextMessage.replace";
      }
    | { error?: ControlError; key: string; type: "panelError.set" }
    | { commandId: string; chunk: string; type: "relay.appendOutput" }
    | {
          commandId: string;
          provider?: string;
          requestId?: string;
          workspace?: string;
          type: "relay.setMetadata";
      }
    | { configView?: Record<string, JsonValue>; type: "control.setConfigView" }
    | { mcpStatus?: McpRuntimeStatus; type: "control.setMcpStatus" }
    | {
          errorCode?: string;
          errorMessage?: string;
          status: TuiConnectionStatus;
          type: "control.setConnectionState";
      }
    | { focusScope: TuiFocusScope; type: "focus.scope.set" }
    | { instance: string; seq: number; type: "instance.setLastSeq" }
    | { instances: TuiInstanceListEntry[]; type: "instance.replaceList" }
    | { entry: TuiLogEntry; type: "log.append" }
    | { instance: string; logs: TuiLogEntry[]; type: "log.replace" }
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
    | { snapshot: InstanceSnapshot; type: "snapshot.replace" }
    | { instance: string; todo: TodoReadResult; type: "todo.replace" }
    | { instance: string; records: ToolCallRecord[]; type: "toolCall.replace" }
    | { maxEvents?: number; rawEvent: TuiRawEventRecord; type: "event.append" };

export function toRawEventRecord(
    event: ClientEvent | InstanceEvent,
): TuiRawEventRecord {
    if ("instanceName" in event) {
        return {
            event: event.type,
            instance: event.instanceName,
            payload: event as unknown as JsonValue,
            seq: event.seq,
        };
    }
    return {
        event: event.name,
        instance: event.destination,
        payload: event.payload,
        seq: event.seq ?? 0,
    };
}
