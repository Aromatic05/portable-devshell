import type { ConnectionState, DaemonState, InstanceName } from "@portable-devshell/shared";

import { createInstanceSnapshot, type InstanceSnapshot } from "./InstanceStateSnapshot.js";
import { type InstanceRuntimeState, deriveRuntimeStatus, isReadyState } from "./InstanceStateRuntime.js";

export interface InstanceStateUpdate {
    connectionState?: ConnectionState;
    daemonState?: DaemonState;
    lastErrorCode?: string;
    lastSeq?: number;
    pid?: number;
}

export class InstanceStateMachine {
    readonly #name: InstanceName;
    #state: InstanceRuntimeState;

    constructor(name: InstanceName) {
        this.#name = name;
        this.#state = {
            connectionState: "disconnected",
            daemonState: "stopped",
            lastSeq: 0,
            ready: false,
            status: "stopped"
        };
    }

    apply(update: InstanceStateUpdate): InstanceSnapshot {
        const daemonState = update.daemonState ?? this.#state.daemonState;
        const connectionState = update.connectionState ?? this.#state.connectionState;
        const lastSeq = update.lastSeq ?? this.#state.lastSeq;
        const pid = Object.prototype.hasOwnProperty.call(update, "pid") ? update.pid : this.#state.pid;
        const lastErrorCode = Object.prototype.hasOwnProperty.call(update, "lastErrorCode")
            ? update.lastErrorCode
            : this.#state.lastErrorCode;

        this.#state = {
            connectionState,
            daemonState,
            lastErrorCode,
            lastSeq,
            pid,
            ready: isReadyState(daemonState, connectionState),
            status: deriveRuntimeStatus(daemonState, connectionState)
        };

        return this.snapshot();
    }

    snapshot(): InstanceSnapshot {
        return createInstanceSnapshot({
            connectionState: this.#state.connectionState,
            daemonState: this.#state.daemonState,
            lastErrorCode: this.#state.lastErrorCode,
            lastSeq: this.#state.lastSeq,
            name: this.#name,
            pid: this.#state.pid
        });
    }

    state(): InstanceRuntimeState {
        return { ...this.#state };
    }
}
