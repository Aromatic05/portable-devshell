import type { InstanceName } from "../types/InstanceName.js";

export type DaemonState = "running" | "starting" | "stopped" | "stopping";

export type ConnectionState = "connected" | "connecting" | "disconnected";

export interface InstanceSnapshot {
    connectionState: ConnectionState;
    daemonState: DaemonState;
    lastErrorCode?: string;
    name: InstanceName;
    pid?: number;
}
