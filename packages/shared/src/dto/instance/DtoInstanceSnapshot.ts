import type { InstanceName } from "../../type/identity/TypeIdentityInstanceName.js";

export type DaemonState = "running" | "starting" | "stopped" | "stale" | "stopping" | "failed";

export type ConnectionState = "connected" | "connecting" | "disconnected" | "reconnecting" | "failed";

export type RuntimeStatus = "ready" | "running" | "stale" | "stopped" | "failed";
export type EffectiveSecurityMode = "disabled" | "workspace";

export interface InstanceSnapshot {
    connectionState: ConnectionState;
    daemonState: DaemonState;
    effectiveSecurityMode?: EffectiveSecurityMode;
    lastSeq: number;
    lastErrorCode?: string;
    name: InstanceName;
    pid?: number;
    ready: boolean;
    status: RuntimeStatus;
}
