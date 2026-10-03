// Reverse-enrollment vocabulary. These describe the Control-plane operations
// and upstream transport used to enroll self-managed instances; an instance's
// observed reverse status is runtime state and lives in runtime/state.

import type { InstanceName } from "../../../runtime/identity/Model.js";

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

export interface ReverseSseFrame {
    frame: string;
    seq: number;
}

export interface ReverseUpstreamBatch {
    frames: ReverseSseFrame[];
    generation: number;
}
