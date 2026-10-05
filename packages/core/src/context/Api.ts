import type {
    ContextEnvironment,
    ContextExternalBinding,
    ContextRecord,
    ContextRegistryPort,
    ContextResolveInput,
    ContextSnapshot,
    JsonValue,
} from "@portable-devshell/shared";

export interface ContextCleanupPort {
    reconcile(ctxId?: string): Promise<void>;
    reconcileInstance(instance: string): Promise<void>;
}

export interface PreparedEnvironmentFacts {
    projectMemoryAgentFile: string;
    projectMemoryDirectory: string;
    projectMemoryPresent?: boolean;
    temporaryDirectory: string;
    workspace: string;
}

export interface ContextEnvironmentPort {
    prepareLocal(
        ctxId: string,
        instance: string,
        workspace: string,
        options?: {
            external?: {
                bindings: readonly ContextExternalBinding[];
                principal: string;
            };
            beforeCommit?: (
                prepared: PreparedEnvironmentFacts,
            ) => Promise<void>;
            signal?: AbortSignal;
        },
    ): Promise<PreparedEnvironmentFacts>;
    attachRemote(
        ctxId: string,
        handle: string,
        workspace?: string,
        signal?: AbortSignal,
    ): Promise<JsonValue>;
    maskRemote(
        ctxId: string,
        handle: string,
    ): Promise<{ instance: string; masked: true }>;
    ensurePrepared(
        ctxId: string,
        instance: string,
        workspace?: string,
    ): Promise<ContextEnvironment>;
    rollbackUndisclosed(
        ctxId: string,
        instance: string,
        workspace?: string,
    ): Promise<void>;
}

export interface ContextLifecycleCleanupPort extends ContextCleanupPort {
    terminate(terminal: ContextRecord): Promise<void>;
}

export interface ContextCommittedChange {
    readonly ctxIds: readonly string[];
    readonly revision: number;
}

export interface ContextChangeSlice {
    readonly changes: readonly ContextCommittedChange[];
    readonly kind: "events" | "gap";
    readonly latestRevision: number;
    readonly oldestAvailableRevision: number;
}

export interface ContextChangeSource {
    onChange(listener: (change: ContextCommittedChange) => void): () => void;
    readSince(fromRevision: number): ContextChangeSlice;
}

export interface ContextRecordSourcePort extends ContextRegistryPort {
    readonly changes: ContextChangeSource;
    snapshot(): Promise<ContextSnapshot>;
}

export interface ContextApi {
    readonly cleanup: ContextLifecycleCleanupPort;
    readonly environment: ContextEnvironmentPort;
    readonly registry: ContextRecordSourcePort;
    disable(ctxId: string): Promise<ContextRecord>;
    detachInstance(instance: string): Promise<ContextRecord[]>;
    reconcileInstance(instance: string): Promise<void>;
    renew(ctxId: string): Promise<ContextRecord>;
    resolve(input: ContextResolveInput): Promise<ContextRecord>;
}

export interface ContextRuntimeOptions {
    contextFile: string;
    instances: ContextInstancesPort;
}

export interface ContextRuntime {
    readonly api: ContextApi;
    initialize(): Promise<void>;
    reconcile(): Promise<void>;
    close(): void;
}

import type { WorkerInstance } from "../instance/Public.js";

export type ContextWorkerPort = Pick<
    WorkerInstance,
    | "handshake"
    | "prepareExtensionResource"
    | "prepareWorkspace"
    | "readAlerts"
    | "releaseAlerts"
    | "snapshot"
    | "touchAlerts"
    | "touchTemporaryDirectory"
>;

export interface ContextInstanceLeasePort {
    readonly instance: { readonly worker: ContextWorkerPort };
    release(): void;
}

export interface ContextInstanceReferencePort {
    readonly snapshot: ReturnType<WorkerInstance["snapshot"]>;
    readonly worker: ContextWorkerPort;
}

export interface ContextInstancePort {
    acquireLease(): ContextInstanceLeasePort;
    acquireReference(
        reference: string,
    ): Promise<ContextInstanceReferencePort>;
    releaseReference(reference: string): Promise<void>;
}

export interface ContextInstancesPort {
    get(name: string): ContextInstancePort | undefined;
}
