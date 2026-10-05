import type {
    JsonValue,
    ContextEnvironment,
    ContextExternalBinding,
} from "@portable-devshell/shared";
import type { WorkerInstance } from "../instance/runtime/index.js";

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

export interface ContextCleanupPort {
    reconcile(ctxId?: string): Promise<void>;
    reconcileInstance(instance: string): Promise<void>;
}
