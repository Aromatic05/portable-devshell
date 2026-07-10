import { type ApprovalRequest, type ControlError, type ControlEventEnvelope, type InstanceSnapshot, type JsonValue, type ToolCallRecord } from "@portable-devshell/shared";

import { type TuiActionMenuItem, type TuiEditorState, type TuiUiIntent } from "../interaction/TuiInteractionTypes.js";
import type { AuditPageState, FocusScope, PageId, SidebarCursor, SidebarFocus } from "../model/TuiUiTypes.js";
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
} from "./TuiReducers.js";

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

    setFocusScope(focusScope: FocusScope): void {
        this.dispatch({
            focusScope,
            type: "focus.scope.set"
        });
    }

    setAuditPage(auditPage: AuditPageState): void {
        this.dispatch({
            auditPage,
            type: "auditPage.set"
        });
    }

    setSidebarFocus(sidebarFocus: SidebarFocus): void {
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

    setSelectedPage(page: PageId): void {
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

    pushRestore(focusScope: FocusScope, sidebarFocus: SidebarFocus, mainFocusId?: string): void {
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

    setActionMenu(title: string, items: TuiActionMenuItem[], selectedIndex = 0): void {
        this.dispatch({
            items,
            selectedIndex,
            title,
            type: "overlay.setActionMenu"
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

    setSidebarCursor(cursor?: SidebarCursor): void {
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

    setSearchQuery(page: PageId, query: string): void {
        this.dispatch({
            page,
            query,
            type: "search.setQuery"
        });
    }

    setScreenStatus(page: PageId, status?: string): void {
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

    appendRawEvent(envelope: ControlEventEnvelope): void {
        this.dispatch({
            rawEvent: toRawEventRecord(envelope),
            type: "event.append"
        });
    }

    applyEvent(envelope: ControlEventEnvelope): void {
        const lastSeq = this.#state.lastSeqByInstance[envelope.target.instance] ?? 0;

        if (envelope.seq <= lastSeq) {
            return;
        }

        this.appendRawEvent(envelope);
    }
}
