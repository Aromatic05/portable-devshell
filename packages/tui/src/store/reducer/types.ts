import type { ApprovalRequest, ArtifactShareResult, ArtifactTransferRecord, ControlError, ControlEventEnvelope, InstanceSnapshot, JsonValue, OAuthApprovalRequest, TodoReadResult, ToolCallRecord } from "@portable-devshell/shared";

import type { TuiEditorState, TuiInteractionState, TuiUiIntent } from "../../interaction/TuiInteractionTypes.js";
import type { AuditPageState, FocusScope, PageId, SidebarCursor, SidebarFocus, TuiUiState } from "../../model/TuiUiTypes.js";

export type TuiConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

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
    source?: "cli" | "tui" | "mcp";
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
    configView?: Record<string, JsonValue>;
    connection: TuiConnectionState;
    globalDerived: TuiGlobalDerivedState;
    interaction: TuiInteractionState;
    instances: TuiInstanceListEntry[];
    lastSeqByInstance: Record<string, number>;
    lastStatusChangeAtByInstance: Record<string, string>;
    logsByInstance: Record<string, TuiLogEntry[]>;
    mcpStatus?: Record<string, JsonValue>;
    oauthApprovals: OAuthApprovalRequest[];
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
    | { approvals: ApprovalRequest[]; instance: string; type: "approval.replace" }
    | { approvals: OAuthApprovalRequest[]; type: "oauthApproval.replace" }
    | { command: TuiCommandRecord; type: "command.upsert" }
    | { error?: ControlError; key: string; type: "panelError.set" }
    | { commandId: string; chunk: string; type: "relay.appendOutput" }
    | { commandId: string; provider?: string; requestId?: string; workspace?: string; type: "relay.setMetadata" }
    | { configView?: Record<string, JsonValue>; type: "control.setConfigView" }
    | { mcpStatus?: Record<string, JsonValue>; type: "control.setMcpStatus" }
    | { errorCode?: string; errorMessage?: string; status: TuiConnectionStatus; type: "control.setConnectionState" }
    | { focusScope: FocusScope; type: "focus.scope.set" }
    | { auditPage: AuditPageState; type: "auditPage.set" }
    | { instance: string; seq: number; type: "instance.setLastSeq" }
    | { instances: TuiInstanceListEntry[]; type: "instance.replaceList" }
    | { entry: TuiLogEntry; type: "log.append" }
    | { instance: string; logs: TuiLogEntry[]; type: "log.replace" }
    | { type: "log.clearBuffer" }
    | { mainFocusId?: string; type: "mainFocus.set" }
    | { button: "cancel" | "confirm"; type: "confirm.focus" }
    | { key: string; lineId?: string; type: "detailLine.select" }
    | { cursor?: SidebarCursor; type: "sidebar.cursor.set" }
    | { confirmIntent: TuiUiIntent; body: string; cancelLabel: string; confirmLabel: string; open: boolean; title: string; type: "overlay.setConfirmDialog" }
    | { sidebarFocus: SidebarFocus; type: "sidebar.focus.set" }
    | { type: "search.setOpen"; value: boolean }
    | { page: PageId; query: string; type: "search.setQuery" }
    | { input: string; instance: string; toolName: string; type: "toolForm.set" }
    | { type: "toolForm.clear" }
    | { body: string; open: boolean; scrollOffset: number; title: string; type: "textDetail.set" }
    | { editor?: TuiEditorState; type: "editor.set" }
    | { dirty: boolean; key: string; value: unknown; type: "formDraft.set" }
    | { key: string; type: "formDraft.clear" }
    | { page: PageId; status?: string; type: "screen.setStatus" }
    | { instance?: string; type: "ui.selectInstance" }
    | { page: PageId; type: "ui.selectPage" }
    | { key: string; type: "ui.toggleExpanded" }
    | { key: string; offset: number; type: "ui.setScrollOffset" }
    | { follow: boolean; instance: string; type: "logs.setFollow" }
    | { instance: string; seq?: number; type: "logs.setPausedAtSeq" }
    | { required: boolean; type: "control.setRestartRequired" }
    | { type: "ui.bumpRedrawNonce" }
    | { snapshot: InstanceSnapshot; type: "snapshot.replace" }
    | { instance: string; todo: TodoReadResult; type: "todo.replace" }
    | { instance: string; records: ToolCallRecord[]; type: "toolCall.replace" }
    | { maxEvents?: number; rawEvent: TuiRawEventRecord; type: "event.append" }
    | { type: "restore.pop" }
    | { focusScope: FocusScope; mainFocusId?: string; sidebarFocus: SidebarFocus; type: "restore.push" };

export function toRawEventRecord(envelope: ControlEventEnvelope): TuiRawEventRecord {
    return {
        event: envelope.event,
        instance: envelope.target.instance,
        payload: envelope.payload,
        seq: envelope.seq
    };
}
