import type { ExtensionJsonValue } from "../ExtensionCore.js";

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
    /** Optional parent Context; the host validates its Instance/Workspace binding. */
    ctxId?: string;
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

/** Worker execution whose ToolCall transcript remains host-owned. */
export interface ExtensionWorkerExecuteCapability
    extends ExtensionWorkerCapability {}

/** Worker execution delegated to an Extension-owned transcript/runtime. */
export interface ExtensionWorkerDelegateCapability
    extends ExtensionWorkerCapability {}

/** A path within the owning Extension's Worker resource collection. */
export interface ExtensionWorkerResourcePath {
    readonly collection: string;
    readonly key?: string;
    readonly path?: string;
}

export interface ExtensionWorkerProcessStartInput {
    readonly instance: string;
    readonly executable: ExtensionWorkerResourcePath;
    readonly args?: readonly (string | ExtensionWorkerResourcePath)[];
    readonly cwd?: ExtensionWorkerResourcePath;
}

/** Duplex bytes from a Worker subprocess, owned by the Extension generation. */
export interface ExtensionWorkerProcess {
    read(): Promise<Uint8Array | undefined>;
    write(bytes: Uint8Array): Promise<void>;
    finish(): Promise<void>;
    close(): Promise<void>;
}

export interface ExtensionWorkerProcessCapability {
    start(input: ExtensionWorkerProcessStartInput, signal?: AbortSignal): Promise<ExtensionWorkerProcess>;
}
