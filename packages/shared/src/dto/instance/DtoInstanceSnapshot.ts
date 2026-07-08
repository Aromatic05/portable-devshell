import type { InstanceName } from "../../type/identity/TypeIdentityInstanceName.js";

export type DaemonState = "running" | "starting" | "stopped" | "stale" | "stopping" | "failed";

export type ConnectionState = "connected" | "connecting" | "disconnected" | "reconnecting" | "failed";

export type RuntimeStatus = "ready" | "running" | "stale" | "stopped" | "failed";

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
