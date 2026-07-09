import type { ApprovalRequest, ControlEventEnvelope, InstanceSnapshot, JsonValue, ToolCallRecord } from "@portable-devshell/shared";

import {
    createInitialTuiAppState,
    toRawEventRecord,
    tuiAppReducer,
    type TuiAppAction,
    type TuiAppState,
    type TuiConnectionStatus,
    type TuiInstanceListEntry,
    type TuiLogEntry,
    type TuiPanel
} from "./TuiReducers.js";
import type { FocusItem, TuiActionMenuItem, TuiMode, TuiUiIntent } from "../interaction/TuiInteractionTypes.js";

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

    setActivePanel(panel: TuiPanel): void {
        this.dispatch({
            panel,
            type: "panel.setActive"
        });
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

    setCurrentFocus(item?: FocusItem): void {
        this.dispatch({
            item,
            type: "focus.setCurrent"
        });
    }

    setMode(mode: TuiMode): void {
        this.dispatch({
            mode,
            type: "mode.set"
        });
    }

    setDirty(value: boolean): void {
        this.dispatch({
            type: "interaction.setDirty",
            value
        });
    }

    toggleExpanded(key: string): void {
        this.dispatch({
            key,
            type: "interaction.toggleExpanded"
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

    setSearchOpen(value: boolean): void {
        this.dispatch({
            type: "search.setOpen",
            value
        });
    }

    setSearchQuery(query: string): void {
        this.dispatch({
            query,
            type: "search.setQuery"
        });
    }

    setScreenStatus(panel: TuiPanel, status?: string): void {
        this.dispatch({
            panel,
            status,
            type: "screen.setStatus"
        });
    }

    setScreenToggle(panel: TuiPanel, value: boolean): void {
        this.dispatch({
            panel,
            type: "screen.setToggle",
            value
        });
    }

    setLogsViewport(topIndex: number, follow: boolean): void {
        this.dispatch({
            follow,
            topIndex,
            type: "logs.setViewport"
        });
    }

    setLogsFollow(follow: boolean): void {
        this.dispatch({
            follow,
            type: "logs.setViewport"
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
