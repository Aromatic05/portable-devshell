import type { ExtensionJsonValue } from "../ExtensionApi.js";

export interface ExtensionWorkerToolDefinition {
    description: string;
    inputSchema: ExtensionJsonValue;
    name: string;
}

export interface ExtensionWorkerShellRuntime {
    executable: string;
    kind: string;
    version: string;
}

export interface ExtensionWorkerDistribution {
    id: string;
    name: string;
    version?: string;
}

export interface ExtensionWorkerPlatform {
    arch: string;
    distribution?: ExtensionWorkerDistribution;
    os: string;
    packageManager?: string;
    shell?: ExtensionWorkerShellRuntime;
}

/** Stable target metadata derived from the Worker handshake. */
export interface ExtensionWorkerEnvironment {
    homeDirectory: string;
    platform: ExtensionWorkerPlatform;
}

export interface ExtensionWorkerOpenInput {
    instance?: string;
    workspace: string;
}

export interface ExtensionWorkerCallOptions {
    onProgress?(progress: ExtensionJsonValue): void;
    operationId?: string;
    signal?: AbortSignal;
}

export interface ExtensionWorkerSession {
    /** Settles whenever this host-managed session ceases to be usable. */
    readonly closed: Promise<void>;
    readonly environment: ExtensionWorkerEnvironment;
    readonly instance: string;
    readonly workspace: string;
    callTool(
        toolName: string,
        input: ExtensionJsonValue,
        options?: ExtensionWorkerCallOptions,
    ): Promise<ExtensionJsonValue>;
    close(): Promise<void>;
    listTools(): readonly ExtensionWorkerToolDefinition[];
}

export interface ExtensionWorkerCapability {
    openSession(
        input: ExtensionWorkerOpenInput,
    ): Promise<ExtensionWorkerSession>;
}
