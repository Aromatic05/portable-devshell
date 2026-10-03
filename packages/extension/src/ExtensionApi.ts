import type {
    ExtensionJsonValue,
    ExtensionPoint,
    ExtensionPointDeclaration,
} from "./ExtensionCore.js";
import type { ExtensionArtifactCapability } from "./domain/artifact.js";
import type { ExtensionAssetCapability } from "./domain/asset.js";
import type {
    ExtensionContextEnvironmentRetiredEvent,
    ExtensionContextObserveCapability,
} from "./domain/context.js";
import type {
    ExtensionInstanceEventPublishCapability,
    ExtensionInstanceGenerationRetiredEvent,
    ExtensionInstanceManageCapability,
    ExtensionInstanceObserveCapability,
} from "./domain/instance.js";
import type { ToolCallHistoryCapability } from "./domain/toolcall.js";
import type { ExtensionProcessCapability } from "./domain/process.js";
import type { ExtensionWorkerCapability } from "./domain/worker.js";

export interface ExtensionErrorOptions {
    readonly code: string;
    readonly details?: ExtensionJsonValue;
    readonly message: string;
    readonly retryable?: boolean;
}

/** Public structured error that preserves an Extension-owned protocol code across the sandbox boundary. */
export class ExtensionError extends Error {
    readonly code: string;
    readonly details?: ExtensionJsonValue;
    readonly retryable: boolean;

    constructor(options: ExtensionErrorOptions) {
        super(options.message);
        this.name = "ExtensionError";
        this.code = requireExtensionErrorCode(options.code);
        this.details = options.details;
        this.retryable = options.retryable ?? false;
    }
}

export type ExtensionConfigAccess = "read" | "read-write";

export interface ExtensionConfigDeclaration {
    readonly access?: Readonly<Record<string, ExtensionConfigAccess>>;
    readonly default?: Readonly<Record<string, ExtensionJsonValue>>;
    readonly schema?:
        | boolean
        | Readonly<Record<string, ExtensionJsonValue>>;
}

export interface ExtensionConfigChange {
    readonly paths: readonly string[];
}

export interface ExtensionConfig {
    get(path: string): Promise<ExtensionJsonValue | undefined>;
    onChange(listener: (change: ExtensionConfigChange) => void): () => void;
    update(
        patch: Readonly<Record<string, ExtensionJsonValue>>,
    ): Promise<void>;
}

export type ExtensionActivationPolicy = "eager" | "lazy";

/** Host-managed runtime resource categories granted to one Extension generation. */
export type ExtensionCapability =
    | "artifacts"
    | "assets"
    | "context.observe"
    | "instance.events.publish"
    | "instance.manage"
    | "instance.observe"
    | "processes"
    | "toolcall.history"
    | "worker.delegate"
    | "worker.execute";

export interface ExtensionManifest {
    activation: ExtensionActivationPolicy;
    apiVersion: string;
    capabilities: readonly ExtensionCapability[];
    config?: ExtensionConfigDeclaration;
    entry: string;
    /** Static declarations keyed by stable domain-owned Extension Point id. */
    extensions: Readonly<Record<string, readonly ExtensionPointDeclaration[]>>;
    /** Bare package roots and compatible versions accepted from the host's shared dependency tree. */
    hostDependencies: Readonly<Record<string, string>>;
    id: string;
    name: string;
    schemaVersion: string;
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

/** Capabilities supplied by Control to an activated Extension generation. */
export interface ExtensionCapabilities {
    readonly artifacts?: ExtensionArtifactCapability;
    readonly assets?: ExtensionAssetCapability;
    readonly contextObserve?: ExtensionContextObserveCapability;
    readonly instanceEventPublish?: ExtensionInstanceEventPublishCapability;
    readonly instanceManage?: ExtensionInstanceManageCapability;
    readonly instanceObserve?: ExtensionInstanceObserveCapability;
    readonly processes?: ExtensionProcessCapability;
    readonly toolCallHistory?: ToolCallHistoryCapability;
    /** Controlled Worker execution whose tool transcript is owned by the delegating Extension. */
    readonly workerDelegate?: ExtensionWorkerCapability;
    readonly workerExecute?: ExtensionWorkerCapability;
}

export interface ExtensionContext {
    readonly capabilities: ExtensionCapabilities;
    readonly config?: ExtensionConfig;
    readonly generation: string;
    readonly id: string;
    readonly logger: ExtensionLogger;
    readonly paths: ExtensionPaths;
    readonly version: string;
    register<Declaration extends ExtensionPointDeclaration, Binding>(
        point: ExtensionPoint<Declaration, Binding>,
        id: string,
        binding: Binding,
    ): void;
}

export interface ExtensionModule {
    activate(context: ExtensionContext): Promise<void> | void;
    /** Extension-owned graceful cleanup only; host-managed resources are reclaimed independently. */
    deactivate?(): Promise<void> | void;
    /** Observe terminal cleanup of one Context attachment; host resources are independently owned. */
    contextEnvironmentRetired?(
        event: ExtensionContextEnvironmentRetiredEvent,
    ): Promise<void> | void;
    /** Gracefully release Extension-owned state before one Instance runtime generation is reclaimed. */
    instanceGenerationRetired?(
        event: ExtensionInstanceGenerationRetiredEvent,
    ): Promise<void> | void;
}

function requireExtensionErrorCode(value: string): string {
    if (/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/u.test(value))
        return value;
    throw new TypeError("Extension error code must be a namespaced identifier.");
}
