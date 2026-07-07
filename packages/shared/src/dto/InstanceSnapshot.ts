import type { InstanceName } from "../types/InstanceName.js";

export type DaemonState = "running" | "starting" | "stopped" | "stopping";

export type ConnectionState = "connected" | "connecting" | "disconnected";

export type RuntimeStatus = "ready" | "running" | "stale" | "stopped";

export interface InstanceSnapshot {
    connectionState: ConnectionState;
    daemonState: DaemonState;
    lastSeq: number;
    lastErrorCode?: string;
    name: InstanceName;
    pid?: number;
    ready: boolean;
    status: RuntimeStatus;
}
