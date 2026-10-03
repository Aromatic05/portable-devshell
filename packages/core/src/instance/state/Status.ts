import type {
    ConnectionState,
    DaemonState,
    ProcessStatus,
} from "@portable-devshell/shared";

export interface InstanceProcessState {
    connectionState: ConnectionState;
    daemonState: DaemonState;
    lastErrorCode?: string;
    lastErrorMessage?: string;
    lastSeq: number;
    pid?: number;
    ready: boolean;
    status: ProcessStatus;
}

export function deriveProcessStatus(
    daemonState: DaemonState,
    connectionState: ConnectionState,
): ProcessStatus {
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

export function isReadyState(
    daemonState: DaemonState,
    connectionState: ConnectionState,
): boolean {
    return deriveProcessStatus(daemonState, connectionState) === "ready";
}
