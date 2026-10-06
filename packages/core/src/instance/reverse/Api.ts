import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { ControlConfig, InstanceName } from "@portable-devshell/shared";

import type { Instance } from "../model/Instance.js";

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

interface ConnectionLifecyclePort {
    registerInstanceDeleteRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void;
    registerInstanceDisableRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void;
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

interface ConnectionMcpPort {
    readonly instanceEditor: ConnectionLifecyclePort;
    readonly host?: {
        readonly server: ReverseHttpHost;
    };
}

interface ConnectionStatePort {
    readonly homeDirectory?: string;
    readonly instances: ReverseInstanceLookup;
    requireConfig(): ControlConfig;
}

export interface ConnectionModuleOptions {
    mcp: ConnectionMcpPort;
    state: ConnectionStatePort;
}
