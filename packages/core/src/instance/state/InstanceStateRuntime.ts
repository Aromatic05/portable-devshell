import type { ConnectionState, DaemonState, RuntimeStatus } from "@portable-devshell/shared";

export interface InstanceRuntimeState {
    connectionState: ConnectionState;
    daemonState: DaemonState;
    lastErrorCode?: string;
    lastSeq: number;
    pid?: number;
    ready: boolean;
    status: RuntimeStatus;
}

export function deriveRuntimeStatus(
    daemonState: DaemonState,
    connectionState: ConnectionState
): RuntimeStatus {
    if (daemonState === "stopped" || daemonState === "stopping") {
        return "stopped";
    }

    if (daemonState === "running" && connectionState === "connected") {
        return "ready";
    }

    if (daemonState === "running" && connectionState === "disconnected") {
        return "stale";
    }

    return "running";
}

export function isReadyState(daemonState: DaemonState, connectionState: ConnectionState): boolean {
    return deriveRuntimeStatus(daemonState, connectionState) === "ready";
}
