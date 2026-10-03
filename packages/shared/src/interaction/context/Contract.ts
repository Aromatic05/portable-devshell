// Context control contract. Context records are read and mutated over the
// control `context` port; no instance event stream is involved.
//
// ContextRegistryPort is the authority-side service interface implemented by the
// control registry. ContextContract is the wire shape of the operations the
// control `context` port exposes to clients.

import type { GoalActivityKind } from "../../runtime/task/goal/Model.js";
import type {
    McpContextAutomaticReentryMode,
    McpContextAutomaticReentrySourceKind,
    McpContextAutomaticReentryState,
    McpContextBinding,
    McpContextEnvironment,
    McpContextEnvironmentBinding,
    McpContextEnvironmentCleanup,
    McpContextExternalBinding,
    McpContextInstanceReference,
    McpContextMaskedInstance,
    McpContextQuery,
    McpContextRecord,
    McpContextValidationBinding,
} from "./Model.js";

export interface ContextRegistryPort {
    initialize(): Promise<void>;
    create(binding: McpContextBinding): Promise<McpContextRecord>;
    bindExternal(
        ctxId: string,
        external: McpContextExternalBinding,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord>;
    lookupExternal(
        external: McpContextExternalBinding,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord | undefined>;
    resolveExternal(
        external: McpContextExternalBinding,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord>;
    lookup(
        ctxId: string,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord>;
    validateAndTouch(
        ctxId: string,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord>;
    validate(
        ctxId: string,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord>;
    validateForInstance(
        ctxId: string,
        instance: string,
        options?: { execution?: boolean },
    ): Promise<McpContextRecord>;
    assertInstanceAvailable(ctxId: string, instance: string): Promise<void>;
    attachEnvironment(
        ctxId: string,
        binding: McpContextEnvironmentBinding,
        external?: {
            bindings: readonly McpContextExternalBinding[];
            principal: string;
        },
    ): Promise<McpContextRecord>;
    resolveEnvironment(
        ctxId: string,
        instance: string,
    ): Promise<McpContextEnvironment | undefined>;
    detachEnvironment(
        ctxId: string,
        instance: string,
    ): Promise<McpContextRecord>;
    detachInstance(instance: string): Promise<McpContextRecord[]>;
    referenceInstance(
        ctxId: string,
        instance: string,
    ): Promise<McpContextInstanceReference | undefined>;
    resolveRemoteInstanceHandle(ctxId: string, handle: string): Promise<string>;
    maskRemoteInstance(
        ctxId: string,
        handle: string,
    ): Promise<McpContextMaskedInstance>;
    list(query?: McpContextQuery): Promise<McpContextRecord[]>;
    listCleanupPending(): Promise<McpContextRecord[]>;
    listEnvironmentCleanup(
        ctxId?: string,
    ): Promise<Array<{ cleanup: McpContextEnvironmentCleanup; ctxId: string }>>;
    recordEnvironmentCleanup(
        ctxId: string,
        cleanup: McpContextEnvironmentCleanup,
    ): Promise<void>;
    settleEnvironmentCleanup(
        ctxId: string,
        cleanup: McpContextEnvironmentCleanup,
    ): Promise<void>;
    disable(ctxId: string): Promise<McpContextRecord>;
    settleCleanup(ctxId: string): Promise<void>;
    discard(ctxId: string): Promise<McpContextRecord>;
    renewForPrincipal(
        ctxId: string,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord>;
    renew(ctxId: string): Promise<McpContextRecord>;
    updateWorkerState(
        ctxId: string,
        instance: string,
        binding: Pick<
            McpContextEnvironmentBinding,
            "temporaryDirectory" | "workspace"
        >,
    ): Promise<McpContextRecord>;
    readAutomaticReentry(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState>;
    suppressAutomaticReentry(
        ctxId: string,
        instance: string,
        reason: string,
        mode?: Exclude<McpContextAutomaticReentryMode, "automatic">,
    ): Promise<McpContextAutomaticReentryState>;
    resumeAutomaticReentry(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState>;
    observeAutomaticReentryActivity(
        ctxId: string,
        instance: string,
        activity: GoalActivityKind,
    ): Promise<McpContextAutomaticReentryState>;
    observeExecutionActivity(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState>;
    releaseExecutionActivity(
        ctxId: string,
        instance: string,
        expectedEpoch: number,
    ): Promise<McpContextAutomaticReentryState>;
    markAutomaticReentryAttempted(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<McpContextAutomaticReentryState>;
    markAutomaticReentryAccepted(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<McpContextAutomaticReentryState>;
    markAutomaticReentryRejected(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<McpContextAutomaticReentryState>;
    claimAutomaticReentry(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<{ claimed: boolean; state: McpContextAutomaticReentryState }>;
    bindAutomaticReentrySource(
        ctxId: string,
        instance: string,
        claimId: string,
        sourceKind: McpContextAutomaticReentrySourceKind,
        sourceId: string,
    ): Promise<McpContextAutomaticReentryState>;
    validateAutomaticReentry(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<{ state: McpContextAutomaticReentryState; valid: boolean }>;
    releaseAutomaticReentry(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<McpContextAutomaticReentryState>;
    clearAutomaticReentryClaim(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState>;
    listAutomaticReentryClaimsForInstance(instance: string): Promise<
        Array<{
            attempted: boolean;
            claimId: string;
            ctxId: string;
            sourceId?: string;
            sourceKind?: McpContextAutomaticReentrySourceKind;
        }>
    >;
}

export const contextOperations = {
    disable: "disable",
    list: "list",
    renew: "renew",
} as const;

export interface ContextContract {
    disable: {
        request: { ctxId: string };
        response: McpContextRecord;
    };
    list: {
        request: undefined;
        response: McpContextRecord[];
    };
    renew: {
        request: { ctxId: string };
        response: McpContextRecord;
    };
}

export type ContextOperation = keyof ContextContract;

export type ContextRequestPayload<Operation extends ContextOperation> =
    ContextContract[Operation]["request"];

export type ContextResponse<Operation extends ContextOperation> =
    ContextContract[Operation]["response"];
