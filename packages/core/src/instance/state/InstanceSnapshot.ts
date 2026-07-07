import type {
    ConnectionState,
    DaemonState,
    InstanceName,
    InstanceSnapshot as SharedInstanceSnapshot
} from "@portable-devshell/shared";

import { deriveRuntimeStatus, isReadyState } from "./InstanceRuntimeState.js";

export type InstanceSnapshot = SharedInstanceSnapshot;

export interface InstanceSnapshotInput {
    connectionState: ConnectionState;
    daemonState: DaemonState;
    lastErrorCode?: string;
    lastSeq: number;
    name: InstanceName;
    pid?: number;
}

export function createInstanceSnapshot(input: InstanceSnapshotInput): InstanceSnapshot {
    const status = deriveRuntimeStatus(input.daemonState, input.connectionState);

    return {
        connectionState: input.connectionState,
        daemonState: input.daemonState,
        lastErrorCode: input.lastErrorCode,
        lastSeq: input.lastSeq,
        name: input.name,
        pid: input.pid,
        ready: isReadyState(input.daemonState, input.connectionState),
        status
    };
}
