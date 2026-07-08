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
    if (daemonState === "failed" || connectionState === "failed") {
        return "failed";
    }

    if (daemonState === "stale") {
        return "stale";
    }

    if (daemonState === "stopped" || daemonState === "stopping") {
        return "stopped";
    }

    if (daemonState === "running" && connectionState === "connected") {
        return "ready";
    }

    return "running";
}

export function isReadyState(daemonState: DaemonState, connectionState: ConnectionState): boolean {
    return deriveRuntimeStatus(daemonState, connectionState) === "ready";
}
