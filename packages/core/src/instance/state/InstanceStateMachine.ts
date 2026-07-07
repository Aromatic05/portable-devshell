import type {
    ConnectionState,
    DaemonState
} from "../../../../shared/dist/dto/InstanceSnapshot.js";
import type { InstanceName } from "../../../../shared/dist/types/InstanceName.js";

import { createInstanceSnapshot, type InstanceSnapshot } from "./InstanceSnapshot.js";
import { type InstanceRuntimeState, deriveRuntimeStatus, isReadyState } from "./InstanceRuntimeState.js";

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

        this.#state = {
            connectionState,
            daemonState,
            lastErrorCode: update.lastErrorCode ?? this.#state.lastErrorCode,
            lastSeq,
            pid: update.pid ?? this.#state.pid,
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
