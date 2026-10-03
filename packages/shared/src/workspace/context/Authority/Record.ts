import type {
    McpContextBinding,
    McpContextEnvironment,
    McpContextEnvironmentBinding,
    McpContextExternalBinding,
    McpContextInstanceReference,
    McpContextMaskedInstance,
    McpContextQuery,
    McpContextRecord,
    McpContextValidationBinding,
} from "../Model.js";

export interface ContextRecordPort {
    initialize(): Promise<void>;
    create(binding: McpContextBinding): Promise<McpContextRecord>;
    bindExternal(ctxId: string, external: McpContextExternalBinding, binding: McpContextValidationBinding): Promise<McpContextRecord>;
    lookupExternal(external: McpContextExternalBinding, binding: McpContextValidationBinding): Promise<McpContextRecord | undefined>;
    resolveExternal(external: McpContextExternalBinding, binding: McpContextValidationBinding): Promise<McpContextRecord>;
    lookup(ctxId: string, binding: McpContextValidationBinding): Promise<McpContextRecord>;
    validateAndTouch(ctxId: string, binding: McpContextValidationBinding): Promise<McpContextRecord>;
    validate(ctxId: string, binding: McpContextValidationBinding): Promise<McpContextRecord>;
    validateForInstance(ctxId: string, instance: string, options?: { execution?: boolean }): Promise<McpContextRecord>;
    assertInstanceAvailable(ctxId: string, instance: string): Promise<void>;
    attachEnvironment(
        ctxId: string,
        binding: McpContextEnvironmentBinding,
        external?: { bindings: readonly McpContextExternalBinding[]; principal: string },
    ): Promise<McpContextRecord>;
    resolveEnvironment(ctxId: string, instance: string): Promise<McpContextEnvironment | undefined>;
    detachEnvironment(ctxId: string, instance: string): Promise<McpContextRecord>;
    detachInstance(instance: string): Promise<McpContextRecord[]>;
    referenceInstance(ctxId: string, instance: string): Promise<McpContextInstanceReference | undefined>;
    resolveRemoteInstanceHandle(ctxId: string, handle: string): Promise<string>;
    maskRemoteInstance(ctxId: string, handle: string): Promise<McpContextMaskedInstance>;
    list(query?: McpContextQuery): Promise<McpContextRecord[]>;
    disable(ctxId: string): Promise<McpContextRecord>;
    discard(ctxId: string): Promise<McpContextRecord>;
    renewForPrincipal(ctxId: string, binding: McpContextValidationBinding): Promise<McpContextRecord>;
    renew(ctxId: string): Promise<McpContextRecord>;
    updateWorkerState(
        ctxId: string,
        instance: string,
        binding: Pick<McpContextEnvironmentBinding, "temporaryDirectory" | "workspace">,
    ): Promise<McpContextRecord>;
}
