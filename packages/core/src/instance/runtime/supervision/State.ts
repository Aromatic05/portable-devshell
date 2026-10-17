import type { InstanceEventInput, InstanceEventPort } from "../../Api.js";
import type {
    ConnectionState,
    DaemonState,
    InstanceEventStreamGap,
    InstanceEventStreamSlice,
    InstanceName,
    InstanceSnapshot as SharedInstanceSnapshot,
    JsonValue,
    ReverseInstanceStatus,
} from "@portable-devshell/shared";

import type { ResolvedWorkerInstanceConfig } from "../provision/Config.js";
import { createConnectionChangedEventData, createReadyChangedEventData, createStatusChangedEventData } from "./Event.js";
import {
    deriveProcessStatus,
    isReadyState,
    normalizeLifecycleStatus,
    type InstanceProcessState,
} from "./Status.js";

export type InstanceSnapshot = SharedInstanceSnapshot;

export interface InstanceSnapshotInput {
    connectionState: ConnectionState;
    daemonState: DaemonState;
    lastErrorCode?: string;
    lastErrorMessage?: string;
    lastSeq: number;
    name: InstanceName;
    pid?: number;
}

export interface InstanceStateUpdate {
    connectionState?: ConnectionState;
    daemonState?: DaemonState;
    lastErrorCode?: string;
    lastErrorMessage?: string;
    lastSeq?: number;
    pid?: number;
}

export class InstanceStateMachine {
    readonly #name: InstanceName;
    #state: InstanceProcessState;

    constructor(name: InstanceName) {
        this.#name = name;
        this.#state = {
            connectionState: "disconnected",
            daemonState: "stopped",
            lastSeq: 0,
            ready: false,
            status: "stopped",
        };
    }

    apply(update: InstanceStateUpdate): InstanceSnapshot {
        const daemonState = update.daemonState ?? this.#state.daemonState;
        const connectionState = update.connectionState ?? this.#state.connectionState;
        const lastSeq = update.lastSeq ?? this.#state.lastSeq;
        const pid = Object.prototype.hasOwnProperty.call(update, "pid")
            ? update.pid
            : this.#state.pid;
        const lastErrorCode = Object.prototype.hasOwnProperty.call(update, "lastErrorCode")
            ? update.lastErrorCode
            : this.#state.lastErrorCode;
        const lastErrorMessage = Object.prototype.hasOwnProperty.call(update, "lastErrorMessage")
            ? update.lastErrorMessage
            : this.#state.lastErrorMessage;
        this.#state = {
            connectionState,
            daemonState,
            lastErrorCode,
            lastErrorMessage,
            lastSeq,
            pid,
            ready: isReadyState(daemonState, connectionState),
            status: deriveProcessStatus(daemonState, connectionState),
        };
        return this.snapshot();
    }

    snapshot(): InstanceSnapshot {
        return createInstanceSnapshot({
            connectionState: this.#state.connectionState,
            daemonState: this.#state.daemonState,
            lastErrorCode: this.#state.lastErrorCode,
            lastErrorMessage: this.#state.lastErrorMessage,
            lastSeq: this.#state.lastSeq,
            name: this.#name,
            pid: this.#state.pid,
        });
    }

    state(): InstanceProcessState {
        return { ...this.#state };
    }
}

export class WorkerInstanceState {
    readonly #config: ResolvedWorkerInstanceConfig;
    readonly #events: InstanceEventPort;
    readonly #listeners = new Set<() => void>();
    readonly #onReadyChanged: (ready: boolean) => Promise<void>;
    readonly #stateMachine: InstanceStateMachine;
    #cursorLoaded = false;

    constructor(options: {
        config: ResolvedWorkerInstanceConfig;
        events: InstanceEventPort;
        onReadyChanged(ready: boolean): Promise<void>;
        stateMachine: InstanceStateMachine;
    }) {
        this.#config = options.config;
        this.#events = options.events;
        this.#onReadyChanged = options.onReadyChanged;
        this.#stateMachine = options.stateMachine;
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    metadataChanged(): void {
        this.#notify();
    }

    #notify(): void {
        for (const listener of this.#listeners) {
            try { listener(); } catch { /* Observers cannot fail Worker state updates. */ }
        }
    }

    snapshot(reverse?: ReverseInstanceStatus): InstanceSnapshot {
        this.#loadCursor();
        return {
            ...this.#stateMachine.snapshot(),
            effectiveSecurityMode: this.#config.effectiveSecurityMode,
            ...(reverse === undefined ? {} : { reverse }),
        };
    }

    subscribe(fromSeq = 1): InstanceEventStreamGap | InstanceEventStreamSlice {
        this.#loadCursor();
        return this.#events.readFrom(fromSeq);
    }

    async appendEvent(type: InstanceEventInput["type"], data?: JsonValue) {
        const event = await this.#events.append({
            at: new Date().toISOString(),
            data,
            type,
        });
        this.#stateMachine.apply({ lastSeq: event.seq });
        this.#cursorLoaded = true;
        if (type.startsWith("reverse.")) this.#notify();
        return event;
    }

    #loadCursor(): void {
        if (this.#cursorLoaded) return;
        this.#stateMachine.apply({ lastSeq: this.#events.cursor() });
        this.#cursorLoaded = true;
    }

    async apply(
        update: InstanceStateUpdate,
        reverse?: ReverseInstanceStatus,
    ): Promise<InstanceSnapshot> {
        const previous = this.snapshot(reverse);
        const enteringReady = !previous.ready && isReadyState(
            update.daemonState ?? previous.daemonState,
            update.connectionState ?? previous.connectionState,
        );
        if (enteringReady) {
            // Never publish ready before the associated Worker tool catalog
            // is available. Reverse clients can issue ToolCalls immediately
            // after observing the ready snapshot.
            await this.#onReadyChanged(true);
        }
        this.#stateMachine.apply(update);
        const next = this.snapshot(reverse);
        if (
            previous.daemonState !== next.daemonState ||
            normalizeLifecycleStatus(previous.status) !==
                normalizeLifecycleStatus(next.status)
        ) {
            await this.appendEvent(
                "instance.statusChanged",
                createStatusChangedEventData(previous, next),
            );
        }
        if (previous.connectionState !== next.connectionState) {
            await this.appendEvent(
                "instance.connectionChanged",
                createConnectionChangedEventData(previous, next),
            );
        }
        if (previous.ready !== next.ready) {
            await this.appendEvent(
                "instance.readyChanged",
                createReadyChangedEventData(previous, next),
            );
            if (!next.ready) await this.#onReadyChanged(false);
        }
        if (
            previous.connectionState !== next.connectionState ||
            previous.daemonState !== next.daemonState ||
            previous.pid !== next.pid ||
            previous.lastErrorCode !== next.lastErrorCode ||
            previous.lastErrorMessage !== next.lastErrorMessage
        ) this.#notify();
        return this.snapshot(reverse);
    }
}

export function createInstanceSnapshot(
    input: InstanceSnapshotInput,
): InstanceSnapshot {
    const status = deriveProcessStatus(input.daemonState, input.connectionState);
    return {
        connectionState: input.connectionState,
        daemonState: input.daemonState,
        lastErrorCode: input.lastErrorCode,
        lastErrorMessage: input.lastErrorMessage,
        lastSeq: input.lastSeq,
        name: input.name,
        pid: input.pid,
        ready: isReadyState(input.daemonState, input.connectionState),
        status,
    };
}
