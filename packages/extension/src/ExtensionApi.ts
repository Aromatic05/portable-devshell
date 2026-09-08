export type ExtensionJsonPrimitive = boolean | number | string | null;
export type ExtensionJsonValue =
    | ExtensionJsonPrimitive
    | ExtensionJsonValue[]
    | { [key: string]: ExtensionJsonValue };

/** Public capabilities granted by Control to one Extension generation. */
export type ExtensionCapability =
    | "assets"
    | "command"
    | "instance-lifecycle"
    | "rpc"
    | "web"
    | "worker";

export interface ExtensionManifest {
    apiVersion: number;
    capabilities: readonly ExtensionCapability[];
    entry: string;
    id: string;
    name: string;
    schemaVersion: number;
    version: string;
}

export interface ExtensionPaths {
    /** Immutable directory containing the selected Extension generation. */
    codeDirectory: string;
    /** Persistent Extension-owned data shared across generations. */
    dataDirectory: string;
    /** Ephemeral per-generation directory owned by Control. */
    runtimeDirectory: string;
    /** Mutable Extension state shared across generations. */
    stateDirectory: string;
}

export interface ExtensionLogger {
    debug(message: string, details?: ExtensionJsonValue): void;
    error(message: string, details?: ExtensionJsonValue): void;
    info(message: string, details?: ExtensionJsonValue): void;
    warn(message: string, details?: ExtensionJsonValue): void;
}

/**
 * One immutable, content-addressed Extension asset bundle.
 *
 * generation is opaque to Extensions. directory is valid while the bundle is
 * installed; callers must not derive sibling paths or depend on Control's
 * physical storage layout.
 */
export interface ExtensionAssetBundle {
    readonly directory: string;
    readonly generation: string;
}

export interface ExtensionAssetTransferTarget {
    /** Managed Worker instance receiving the asset. */
    instance: string;
    /** Destination path interpreted relative to workspace unless explicitly absolute. */
    path: string;
    /** Absolute target-side workspace used by the Artifact receive path. */
    workspace: string;
}

export interface ExtensionAssetTransferInput {
    generation: string;
    overwrite?: boolean;
    signal?: AbortSignal;
    target: ExtensionAssetTransferTarget;
}

export interface ExtensionAssetTransferResult {
    readonly transferId: string;
    readonly transferredBytes: number;
}

/**
 * Control-owned storage and transfer for Extension assets.
 *
 * Asset semantics (provider selection, Skill identity, profiles, etc.) remain
 * owned by the Extension. Control owns only immutable bundle storage and byte
 * transfer through the Artifact subsystem.
 */
export interface ExtensionAssetCapability {
    installBundle(sourcePath: string): Promise<ExtensionAssetBundle>;
    installDirectory(sourcePath: string): Promise<ExtensionAssetBundle>;
    listBundles(): Promise<readonly ExtensionAssetBundle[]>;
    removeBundle(generation: string): Promise<void>;
    resolveBundle(generation: string): Promise<ExtensionAssetBundle | undefined>;
    transferBundle(input: ExtensionAssetTransferInput): Promise<ExtensionAssetTransferResult>;
}

export interface ExtensionToolDefinition {
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
    readonly environment: ExtensionWorkerEnvironment;
    readonly instance: string;
    readonly workspace: string;
    callTool(
        toolName: string,
        input: ExtensionJsonValue,
        options?: ExtensionWorkerCallOptions
    ): Promise<ExtensionJsonValue>;
    close(): Promise<void>;
    listTools(): readonly ExtensionToolDefinition[];
}

export interface ExtensionWorkerCapability {
    openSession(input: ExtensionWorkerOpenInput): Promise<ExtensionWorkerSession>;
}

/** Capabilities supplied by Control to an activated Extension generation. */
export interface ExtensionContext {
    readonly assets: ExtensionAssetCapability;
    readonly generation: string;
    readonly id: string;
    readonly logger: ExtensionLogger;
    readonly paths: ExtensionPaths;
    readonly version: string;
    readonly worker: ExtensionWorkerCapability;
}

export interface ExtensionInvocationContext {
    /** True only for a request authenticated as the local Control owner. */
    readonly localOwner: boolean;
    readonly requestId: string;
    readonly signal: AbortSignal;
    /** Local-owner CLI working directory on the Control host, when supplied. */
    readonly workingDirectory?: string;
}

export type ExtensionRpcHandler = (
    input: ExtensionJsonValue | undefined,
    context: ExtensionInvocationContext
) => ExtensionJsonValue | Promise<ExtensionJsonValue>;

export type ExtensionCommandResult =
    | { kind: "json"; value: ExtensionJsonValue }
    | { kind: "text"; text: string };

export type ExtensionCommandHandler = (
    argv: readonly string[],
    context: ExtensionInvocationContext
) => ExtensionCommandResult | Promise<ExtensionCommandResult>;

export type ExtensionWebContribution =
    | {
          /** Relative directory below codeDirectory. */
          directory: string;
          kind: "static";
      }
    | {
          kind: "proxy";
          resolveUpstream(): URL | Promise<URL | undefined> | undefined;
      };

export interface ExtensionInstanceRetireEvent {
    instance: string;
    reason: "deleted" | "disabled";
}

export interface ExtensionLifecycleHandlers {
    onInstanceRetire?(event: ExtensionInstanceRetireEvent): Promise<void> | void;
}

/** Contributions supplied by an Extension to Control. */
export interface ExtensionActivation {
    command?: ExtensionCommandHandler;
    dispose(): Promise<void> | void;
    lifecycle?: ExtensionLifecycleHandlers;
    rpc?: Readonly<Record<string, ExtensionRpcHandler>>;
    web?: ExtensionWebContribution;
}

export interface ExtensionModule {
    activate(context: ExtensionContext): ExtensionActivation | Promise<ExtensionActivation>;
}
