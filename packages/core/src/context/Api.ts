import type {
    ContextBinding,
    ContextEnvironment,
    ContextEnvironmentBinding,
    ContextEnvironmentCleanup,
    ContextExternalBinding,
    ContextInstanceReference,
    ContextMaskedInstance,
    ContextQuery,
    ContextRecord,
    ContextResolveInput,
    ContextSnapshot,
    ContextValidationBinding,
    JsonValue,
} from "@portable-devshell/shared";
import type { Instance } from "../instance/Instance.js";
import type { InstanceRegistry } from "../instance/Registry.js";

export interface ContextCleanupLedgerPort {
    listCleanupPending(): Promise<ContextRecord[]>;
    listEnvironmentCleanup(
        ctxId?: string,
    ): Promise<Array<{ cleanup: ContextEnvironmentCleanup; ctxId: string }>>;
    recordEnvironmentCleanup(
        ctxId: string,
        cleanup: ContextEnvironmentCleanup,
    ): Promise<void>;
    settleCleanup(ctxId: string): Promise<void>;
    settleEnvironmentCleanup(
        ctxId: string,
        cleanup: ContextEnvironmentCleanup,
    ): Promise<void>;
}

export interface ContextRecordPort {
    initialize(): Promise<void>;
    create(binding: ContextBinding): Promise<ContextRecord>;
    lookupExternal(
        external: ContextExternalBinding,
        binding: ContextValidationBinding,
    ): Promise<ContextRecord | undefined>;
    lookup(
        ctxId: string,
        binding: ContextValidationBinding,
    ): Promise<ContextRecord>;
    validateAndTouch(
        ctxId: string,
        binding: ContextValidationBinding,
    ): Promise<ContextRecord>;
    validate(
        ctxId: string,
        binding: ContextValidationBinding,
    ): Promise<ContextRecord>;
    validateForInstance(ctxId: string, instance: string): Promise<ContextRecord>;
    assertInstanceAvailable(ctxId: string, instance: string): Promise<void>;
    attachEnvironment(
        ctxId: string,
        binding: ContextEnvironmentBinding,
        external?: {
            bindings: readonly ContextExternalBinding[];
            principal: string;
        },
    ): Promise<ContextRecord>;
    resolveEnvironment(
        ctxId: string,
        instance: string,
    ): Promise<ContextEnvironment | undefined>;
    detachEnvironment(ctxId: string, instance: string): Promise<ContextRecord>;
    detachInstance(instance: string): Promise<ContextRecord[]>;
    referenceInstance(
        ctxId: string,
        instance: string,
    ): Promise<ContextInstanceReference | undefined>;
    resolveRemoteInstanceHandle(ctxId: string, handle: string): Promise<string>;
    maskRemoteInstance(
        ctxId: string,
        handle: string,
    ): Promise<ContextMaskedInstance>;
    list(query?: ContextQuery): Promise<ContextRecord[]>;
    disable(ctxId: string): Promise<ContextRecord>;
    discard(ctxId: string): Promise<ContextRecord>;
    renewForPrincipal(
        ctxId: string,
        binding: ContextValidationBinding,
    ): Promise<ContextRecord>;
    renew(ctxId: string): Promise<ContextRecord>;
    updateWorkerState(
        ctxId: string,
        instance: string,
        binding: Pick<
            ContextEnvironmentBinding,
            "temporaryDirectory" | "workspace"
        >,
    ): Promise<ContextRecord>;
}

export interface ContextRegistryPort extends
    ContextRecordPort,
    ContextCleanupLedgerPort {}

export interface ContextCleanupPort {
    reconcile(ctxId?: string): Promise<void>;
    reconcileInstance(instance: string, target?: Instance): Promise<void>;
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
    instances: InstanceRegistry;
}

export interface ContextRuntime {
    readonly api: ContextApi;
    initialize(): Promise<void>;
    reconcile(): Promise<void>;
    close(): void;
}
