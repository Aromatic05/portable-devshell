import type { ReverseInstanceStatus } from "../Connection.js";
import type { InstanceName } from "../Identity.js";
import type { ActiveTodoSummary } from "../task/Todo.js";

export type DaemonState =
    "running" | "starting" | "stopped" | "stale" | "stopping" | "failed";
export type ConnectionState =
    "connected" | "connecting" | "disconnected" | "reconnecting" | "failed";
export type RuntimeStatus =
    "ready" | "running" | "stale" | "stopped" | "failed";
export type EffectiveSecurityMode = "disabled" | "workspace";

export interface InstanceSnapshot {
    activeTodos?: ActiveTodoSummary[];
    connectionState: ConnectionState;
    daemonState: DaemonState;
    effectiveSecurityMode?: EffectiveSecurityMode;
    lastSeq: number;
    lastErrorCode?: string;
    lastErrorMessage?: string;
    name: InstanceName;
    pid?: number;
    reverse?: ReverseInstanceStatus;
    ready: boolean;
    status: RuntimeStatus;
}

export interface InstanceRuntimeEnvelope {
    lastSeq: number;
    snapshot: InstanceSnapshot;
}

export interface InstanceListEntry {
    enabled: boolean;
    homeDirectory?: string;
    mcpEnabled: boolean;
    name: string;
    snapshot: InstanceSnapshot;
}
