import type { InstanceName } from "@portable-devshell/shared";
import type { Instance } from "@portable-devshell/core";

export interface ReverseInstanceLookup {
    get(instanceName: string): Instance | undefined;
}

export interface ReverseEnrollmentCredential {
    deviceToken: string;
    instance: string;
}

export interface StoredReverseDeviceCode {
    deviceCode: string;
    expiresAt: string;
    instance: InstanceName;
}
