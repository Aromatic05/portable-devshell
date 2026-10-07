import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { InstanceName } from "@portable-devshell/shared";

import type { Instance } from "@portable-devshell/core";

export interface ReverseConnectionIdentity {
    credentialToken: string;
    descriptor: Instance;
    generation: number;
}

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

export interface ReverseHttpHost {
    registerRawRoute(
        method: "delete" | "get" | "head" | "options" | "post",
        path: string,
        handler: (
            request: IncomingMessage,
            response: ServerResponse,
        ) => void | Promise<void>,
    ): () => void;
    registerUpgradeHandler(
        path: string,
        handler: (
            request: IncomingMessage,
            socket: Duplex,
            head: Buffer,
        ) => void | Promise<void>,
    ): () => void;
}

export interface ConnectionModuleOptions {
    readonly hasReverseInstance: boolean;
    readonly homeDirectory?: string;
    readonly host?: ReverseHttpHost;
    readonly instances: ReverseInstanceLookup;
    readonly publicBaseUrl?: string;
}
