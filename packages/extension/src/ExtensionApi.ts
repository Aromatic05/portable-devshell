export type ExtensionJsonPrimitive = boolean | number | string | null;
export type ExtensionJsonValue =
    | ExtensionJsonPrimitive
    | ExtensionJsonValue[]
    | { [key: string]: ExtensionJsonValue };

/** Host-managed runtime resource categories granted to one Extension generation. */
export type ExtensionCapability = "assets" | "processes" | "workers";

export interface ExtensionPointDeclaration {
    readonly id: string;
}

export interface ExtensionManifest {
    apiVersion: number;
    capabilities: readonly ExtensionCapability[];
    entry: string;
    /** Static declarations keyed by stable domain-owned Extension Point id. */
    extensions: Readonly<Record<string, readonly ExtensionPointDeclaration[]>>;
    /** Bare package roots explicitly accepted from the host's shared dependency tree. */
    hostDependencies: readonly string[];
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
    /** Ephemeral directory owned by one activation incarnation; changes across reloads. */
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

export interface ExtensionAssetTransferResult {
    readonly transferId: string;
    readonly transferredBytes: number;
}

export interface ExtensionAssetProjectionTarget {
    /** Logical resource collection owned by the Extension on the target Worker. */
    collection: string;
    /** Managed Worker instance receiving the resource. */
    instance: string;
    /** One logical entry name inside the collection; never a filesystem path. */
    key: string;
}

export interface ExtensionAssetProjectionInput {
    generation: string;
    overwrite?: boolean;
    signal?: AbortSignal;
    target: ExtensionAssetProjectionTarget;
}

/** Control-owned storage and transfer for Extension assets. */
export interface ExtensionAssetCapability {
    installBundle(sourcePath: string): Promise<ExtensionAssetBundle>;
    installDirectory(sourcePath: string): Promise<ExtensionAssetBundle>;
    listBundles(): Promise<readonly ExtensionAssetBundle[]>;
    projectBundle(input: ExtensionAssetProjectionInput): Promise<ExtensionAssetTransferResult>;
    removeBundle(generation: string): Promise<void>;
    resolveBundle(generation: string): Promise<ExtensionAssetBundle | undefined>;
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
    /** Settles whenever this host-managed session ceases to be usable. */
    readonly closed: Promise<void>;
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

export interface ExtensionProcessExit {
    readonly code?: number;
    readonly signal?: string;
}

/** Input for a Control-owned process. The process remains generation-owned. */
export interface ExtensionProcessStartInput {
    readonly args?: readonly string[];
    readonly command: string;
    readonly cwd?: string;
    readonly environment?: Readonly<Record<string, string>>;
    /** Request a structured JSON message channel in addition to process lifetime management. */
    readonly messages?: boolean;
}

export interface ExtensionManagedProcess {
    readonly closed: Promise<ExtensionProcessExit>;
    onMessage(listener: (message: ExtensionJsonValue) => void): () => void;
    onStderr(listener: (chunk: string) => void): () => void;
    send(message: ExtensionJsonValue): Promise<void>;
    terminate(signal?: string): Promise<void>;
}

export interface ExtensionProcessCapability {
    start(input: ExtensionProcessStartInput): Promise<ExtensionManagedProcess>;
}

/** Capabilities supplied by Control to an activated Extension generation. */
export interface ExtensionCapabilities {
    readonly assets?: ExtensionAssetCapability;
    readonly processes?: ExtensionProcessCapability;
    readonly workers?: ExtensionWorkerCapability;
}

declare const extensionPointDeclarationType: unique symbol;
declare const extensionPointBindingType: unique symbol;

/** Stable domain-owned point identity plus compile-time declaration/binding types. */
export interface ExtensionPoint<Declaration extends ExtensionPointDeclaration, Binding> {
    readonly id: string;
    readonly [extensionPointBindingType]?: Binding;
    readonly [extensionPointDeclarationType]?: Declaration;
}

/**
 * Define a stable Extension Point descriptor. Runtime identity is the id string,
 * never JavaScript object identity, so descriptors may safely be bundled.
 */
export function defineExtensionPoint<Declaration extends ExtensionPointDeclaration, Binding>(
    id: string
): ExtensionPoint<Declaration, Binding> {
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(id)) {
        throw new TypeError("Extension Point id must be a lowercase namespaced identifier.");
    }
    return Object.freeze({ id }) as ExtensionPoint<Declaration, Binding>;
}

export interface ExtensionContext {
    readonly capabilities: ExtensionCapabilities;
    readonly generation: string;
    readonly id: string;
    readonly logger: ExtensionLogger;
    readonly paths: ExtensionPaths;
    readonly version: string;
    register<Declaration extends ExtensionPointDeclaration, Binding>(
        point: ExtensionPoint<Declaration, Binding>,
        id: string,
        binding: Binding
    ): void;
}

export interface ExtensionModule {
    activate(context: ExtensionContext): Promise<void> | void;
    /** Extension-owned graceful cleanup only; host-managed resources are reclaimed independently. */
    deactivate?(): Promise<void> | void;
}
