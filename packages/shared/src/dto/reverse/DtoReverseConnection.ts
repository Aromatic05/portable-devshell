import type { InstanceName } from "../../type/identity/TypeIdentityInstanceName.js";

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

export interface ReverseDeviceCodeResult {
    controllerUrl: string;
    deviceCode: string;
    expiresAt: string;
    instance: InstanceName;
}

export interface ReverseEnrollmentRequest {
    arch: string;
    deviceCode: string;
    os: string;
    workerVersion: string;
}

export interface ReverseEnrollmentResponse {
    controllerUrl: string;
    deviceToken: string;
    instance: InstanceName;
    workspace: string;
}

export interface ReverseSseFrame {
    frame: string;
    seq: number;
}

export interface ReverseUpstreamBatch {
    frames: ReverseSseFrame[];
    generation: number;
}

export interface ReverseUpstreamAck {
    acceptedThrough: number;
    generation: number;
}
