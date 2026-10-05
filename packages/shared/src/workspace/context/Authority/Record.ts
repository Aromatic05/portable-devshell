import type {
    ContextBinding,
    ContextEnvironment,
    ContextEnvironmentBinding,
    ContextExternalBinding,
    ContextInstanceReference,
    ContextMaskedInstance,
    ContextQuery,
    ContextRecord,
    ContextValidationBinding,
} from "../Model.js";

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
    validateForInstance(
        ctxId: string,
        instance: string,
    ): Promise<ContextRecord>;
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
