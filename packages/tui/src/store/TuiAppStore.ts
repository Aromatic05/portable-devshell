import type { ControlEventEnvelope, InstanceSnapshot, JsonValue } from "@portable-devshell/shared";

import {
    createInitialTuiAppState,
    toRawEventRecord,
    tuiAppReducer,
    type TuiAppAction,
    type TuiAppState,
    type TuiConnectionStatus,
    type TuiInstanceListEntry,
    type TuiPanel
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
