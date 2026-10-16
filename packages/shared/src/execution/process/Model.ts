// Instance runtime state: lifecycle/connection status and the authoritative
// snapshot envelope. The snapshot carries the event sequence used as the
// subscription cursor.

import type { InstanceName } from "../../types/Instance.js";

export type ReverseTransport = "wss" | "sse";
export type ReverseEnrollmentState = "pending" | "enrolled" | "revoked";
export type ReverseAvailability = "offline" | "online";

export interface ReverseInstanceStatus {
    availability: ReverseAvailability;
    connectedAt?: string;
    enrollmentState: ReverseEnrollmentState;
    generation?: number;
    lastErrorCode?: string;
    lastErrorMessage?: string;
    lastSeenAt?: string;
    managementMode: "selfManaged";
    transport?: ReverseTransport;
}

export type DaemonState =
    | "running"
    | "starting"
    | "stopped"
    | "stale"
    | "stopping"
    | "failed"
    | "unknown";
export type ConnectionState =
    "connected" | "connecting" | "disconnected" | "reconnecting" | "failed";
export type ProcessStatus =
    "ready" | "running" | "stale" | "stopped" | "failed" | "offline";
export type EffectiveSecurityMode = "disabled" | "workspace";

export interface InstanceSnapshot {
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
    status: ProcessStatus;
}

export interface InstanceWorkerInfo {
    capabilities: {
        cancel: boolean;
        streaming: boolean;
        tools: boolean;
    };
    platform: {
        arch: string;
        distribution?: {
            id: string;
            name: string;
            version?: string;
        };
        os: string;
        packageManager?: string;
        shell?: {
            executable: string;
            kind: string;
            version: string;
        };
    };
    protocolVersion: string;
    version: string;
}

export interface InstanceProcessEnvelope {
    lastSeq: number;
    snapshot: InstanceSnapshot;
    worker?: InstanceWorkerInfo;
}

export interface InstanceListEntry {
    enabled: boolean;
    homeDirectory?: string;
    mcpEnabled: boolean;
    name: string;
    snapshot: InstanceSnapshot;
}
