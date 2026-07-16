import { type ApprovalRequest, type ArtifactShareResult, type ArtifactTransferRecord, type ClientEvent, type ControlError, type InstanceSnapshot, type JsonValue, type OAuthApprovalRequest, type TodoReadResult, type ToolCallRecord } from "@portable-devshell/shared";

import { type TuiEditorState, type TuiUiIntent } from "../interaction/TuiInteractionModel.js";
import type { TuiAuditPageState, TuiFocusScope, TuiPageId, TuiSidebarCursor, TuiSidebarFocus } from "../view/TuiUiModel.js";
import {
    createInitialTuiAppState,
    toRawEventRecord,
    tuiAppReducer,
    type TuiAppAction,
    type TuiAppState,
    type TuiCommandRecord,
    type TuiConnectionStatus,
    type TuiInstanceListEntry,
    type TuiLogEntry
} from "./TuiStoreTypes.js";

export interface TuiAppStoreOptions {
    initialState?: TuiAppState;
    maxRawEvents?: number;
}

export class TuiAppStore {
    readonly #listeners = new Set<() => void>();
    readonly #maxRawEvents: number;
    #state: TuiAppState;

    constructor(options: TuiAppStoreOptions = {}) {
        this.#maxRawEvents = options.maxRawEvents ?? 100;
        this.#state = options.initialState ?? createInitialTuiAppState();
    }

    getState(): TuiAppState {
        return this.#state;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    dispatch(action: TuiAppAction): void {
        const nextState =
            action.type === "event.append" ? tuiAppReducer(this.#state, { ...action, maxEvents: this.#maxRawEvents }) : tuiAppReducer(this.#state, action);

        if (nextState === this.#state) {
            return;
        }

        this.#state = nextState;
        for (const listener of this.#listeners) {
            listener();
        }
    }

    replaceArtifactShares(shares: ArtifactShareResult[]): void {
        this.dispatch({ shares, type: "artifact.share.replace" });
    }

    upsertArtifactShare(share: ArtifactShareResult): void {
        this.dispatch({ share, type: "artifact.share.upsert" });
    }

    replaceArtifactTransfers(transfers: ArtifactTransferRecord[]): void {
        this.dispatch({ transfers, type: "artifact.transfer.replace" });
    }

    upsertArtifactTransfer(transfer: ArtifactTransferRecord): void {
        this.dispatch({ transfer, type: "artifact.transfer.upsert" });
    }

    setControlRestartRequired(required: boolean): void {
        this.dispatch({ required, type: "control.setRestartRequired" });
    }

    setMcpStatus(mcpStatus?: Record<string, JsonValue>): void {
        this.dispatch({ mcpStatus, type: "control.setMcpStatus" });
    }

    setConfigView(configView?: Record<string, JsonValue>): void {
        this.dispatch({
            configView,
            type: "control.setConfigView"
        });
    }

    setConnectionState(status: TuiConnectionStatus, error?: { code?: string; message?: string }): void {
        this.dispatch({
            errorCode: error?.code,
            errorMessage: error?.message,
            status,
            type: "control.setConnectionState"
        });
    }

    setFocusScope(focusScope: TuiFocusScope): void {
        this.dispatch({
            focusScope,
            type: "focus.scope.set"
        });
    }

    setAuditPage(auditPage: TuiAuditPageState): void {
        this.dispatch({
            auditPage,
            type: "auditPage.set"
        });
    }

    setSidebarFocus(sidebarFocus: TuiSidebarFocus): void {
        this.dispatch({
            sidebarFocus,
            type: "sidebar.focus.set"
        });
    }

    setMainFocusId(mainFocusId?: string): void {
        this.dispatch({
            mainFocusId,
            type: "mainFocus.set"
        });
    }

    setSelectedPage(page: TuiPageId): void {
        this.dispatch({
            page,
            type: "ui.selectPage"
        });
    }

    setSelectedInstance(instance?: string): void {
        this.dispatch({
            instance,
            type: "ui.selectInstance"
        });
    }

    pushRestore(focusScope: TuiFocusScope, sidebarFocus: TuiSidebarFocus, mainFocusId?: string): void {
        this.dispatch({
            focusScope,
            mainFocusId,
            sidebarFocus,
            type: "restore.push"
        });
    }

    popRestore(): void {
        this.dispatch({
            type: "restore.pop"
        });
    }

    setConfirmDialog(input: {
        body: string;
        cancelLabel?: string;
        confirmIntent: TuiUiIntent;
        confirmLabel?: string;
        open: boolean;
        title: string;
    }): void {
        this.dispatch({
            body: input.body,
            cancelLabel: input.cancelLabel ?? "Cancel",
            confirmIntent: input.confirmIntent,
            confirmLabel: input.confirmLabel ?? "Confirm",
            open: input.open,
            title: input.title,
            type: "overlay.setConfirmDialog"
        });
    }

    setConfirmFocus(button: "cancel" | "confirm"): void {
        this.dispatch({
            button,
            type: "confirm.focus"
        });
    }

    setSelectedDetailLine(key: string, lineId?: string): void {
        this.dispatch({
            key,
            lineId,
            type: "detailLine.select"
        });
    }

    setSidebarCursor(cursor?: TuiSidebarCursor): void {
        this.dispatch({
            cursor,
            type: "sidebar.cursor.set"
        });
    }

    setSearchOpen(value: boolean): void {
        this.dispatch({
            type: "search.setOpen",
            value
        });
    }

    setSearchQuery(page: TuiPageId, query: string): void {
        this.dispatch({
            page,
            query,
            type: "search.setQuery"
        });
    }

    setScreenStatus(page: TuiPageId, status?: string): void {
        this.dispatch({
            page,
            status,
            type: "screen.setStatus"
        });
    }

    setPanelError(key: string, error?: ControlError): void {
        this.dispatch({
            error,
            key,
            type: "panelError.set"
        });
    }

    setToolForm(instance: string, toolName: string, input: string): void {
        this.dispatch({
            input,
            instance,
            toolName,
            type: "toolForm.set"
        });
    }

    setTextDetail(input: { body: string; open: boolean; scrollOffset?: number; title: string }): void {
        this.dispatch({
            body: input.body,
            open: input.open,
            scrollOffset: input.scrollOffset ?? 0,
            title: input.title,
            type: "textDetail.set"
        });
    }

    clearToolForm(): void {
        this.dispatch({
            type: "toolForm.clear"
        });
    }

    setEditor(editor?: TuiEditorState): void {
        this.dispatch({ editor, type: "editor.set" });
    }

    setFormDraft(key: string, value: unknown, dirty = true): void {
        this.dispatch({ dirty, key, type: "formDraft.set", value });
    }

    clearFormDraft(key: string): void {
        this.dispatch({ key, type: "formDraft.clear" });
    }

    toggleExpanded(key: string): void {
        this.dispatch({
            key,
            type: "ui.toggleExpanded"
        });
    }

    setLogsFollow(instance: string, follow: boolean): void {
        this.dispatch({ follow, instance, type: "logs.setFollow" });
    }

    setLogsPausedAtSeq(instance: string, seq: number | undefined): void {
        this.dispatch({ instance, ...(seq === undefined ? {} : { seq }), type: "logs.setPausedAtSeq" });
    }

    setScrollOffset(key: string, offset: number): void {
        this.dispatch({
            key,
            offset,
            type: "ui.setScrollOffset"
        });
    }

    clearLogsBuffer(): void {
        this.dispatch({
            type: "log.clearBuffer"
        });
    }

    bumpRedrawNonce(): void {
        this.dispatch({
            type: "ui.bumpRedrawNonce"
        });
    }

    replaceInstances(instances: TuiInstanceListEntry[]): void {
        this.dispatch({
            instances,
            type: "instance.replaceList"
        });
    }

    replaceTodo(instance: string, todo: TodoReadResult): void {
        this.dispatch({ instance, todo, type: "todo.replace" });
    }

    replaceSnapshot(snapshot: InstanceSnapshot): void {
        this.dispatch({
            snapshot,
            type: "snapshot.replace"
        });
    }

    replaceLogs(instance: string, logs: TuiLogEntry[]): void {
        this.dispatch({
            instance,
            logs,
            type: "log.replace"
        });
    }

    appendLog(entry: TuiLogEntry): void {
        this.dispatch({
            entry,
            type: "log.append"
        });
    }

    replaceToolCalls(instance: string, records: ToolCallRecord[]): void {
        this.dispatch({
            instance,
            records,
            type: "toolCall.replace"
        });
    }

    replaceApprovals(instance: string, approvals: ApprovalRequest[]): void {
        this.dispatch({
            approvals,
            instance,
            type: "approval.replace"
        });
    }

    replaceOAuthApprovals(approvals: OAuthApprovalRequest[]): void {
        this.dispatch({
            approvals,
            type: "oauthApproval.replace"
        });
    }

    upsertCommand(command: TuiCommandRecord): void {
        this.dispatch({
            command,
            type: "command.upsert"
        });
    }

    appendRelayOutput(commandId: string, chunk: string): void {
        this.dispatch({
            chunk,
            commandId,
            type: "relay.appendOutput"
        });
    }

    setRelayMetadata(commandId: string, input: { provider?: string; requestId?: string; workspace?: string }): void {
        this.dispatch({
            commandId,
            ...input,
            type: "relay.setMetadata"
        });
    }

    setInstanceLastSeq(instance: string, seq: number): void {
        this.dispatch({
            instance,
            seq,
            type: "instance.setLastSeq"
        });
    }

    appendRawEvent(event: ClientEvent): void {
        this.dispatch({
            rawEvent: toRawEventRecord(event),
            type: "event.append"
        });
    }

    applyEvent(event: ClientEvent): void {
        if (event.destination === "@control" || event.seq === undefined) {
            return;
        }
        const lastSeq = this.#state.lastSeqByInstance[event.destination] ?? 0;

        if (event.seq <= lastSeq) {
            return;
        }

        this.appendRawEvent(event);
    }
}
