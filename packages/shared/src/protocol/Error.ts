import type { JsonValue } from "./JsonValue.js";

export const errorCodes = {
    artifactContentUnavailable: "artifact.contentUnavailable",
    artifactDirectoryUnsafe: "artifact.directoryUnsafe",
    artifactHostPathDenied: "artifact.hostPathDenied",
    artifactImageTooLarge: "artifact.imageTooLarge",
    artifactImageUnsupported: "artifact.imageUnsupported",
    artifactPayloadInvalid: "artifact.payloadInvalid",
    artifactShareExhausted: "artifact.shareExhausted",
    artifactShareExpired: "artifact.shareExpired",
    artifactShareNotFound: "artifact.shareNotFound",
    artifactShareRevoked: "artifact.shareRevoked",
    artifactTransferNotFound: "artifact.transferNotFound",
    artifactTransferStateConflict: "artifact.transferStateConflict",
    artifactTransferInterrupted: "artifact.transferInterrupted",
    controlConfigInvalid: "control.configInvalid",
    controlClientIdentityInvalid: "control.clientIdentityInvalid",
    controlClientIdentityRequired: "control.clientIdentityRequired",
    controlConfigLoadFailed: "control.configLoadFailed",
    controlConfigParseFailed: "control.configParseFailed",
    controlConfigValidationFailed: "control.configValidationFailed",
    controlCliAccessDenied: "control.cliAccessDenied",
    controlCliCommandFailed: "control.cliCommandFailed",
    controlCliCommandInvalid: "control.cliCommandInvalid",
    controlDebugAccessDenied: "control.debugAccessDenied",
    controlDebugPatchInvalid: "control.debugPatchInvalid",
    controlDebugPatchNotFound: "control.debugPatchNotFound",
    controlDebugTargetNotFound: "control.debugTargetNotFound",
    controlExtensionAccessDenied: "control.extensionAccessDenied",
    controlExtensionFailed: "control.extensionFailed",
    controlExtensionInvalid: "control.extensionInvalid",
    controlExtensionNotActive: "control.extensionNotActive",
    controlExtensionNotFound: "control.extensionNotFound",
    controlModelReplyRequired: "control.modelReplyRequired",
    controlModelResumed: "control.modelResumed",
    controlModelStopped: "control.modelStopped",
    controlWebAccessDenied: "control.webAccessDenied",
    controlRestartFailed: "control.restartFailed",
    coreApprovalAlreadyDecided: "core.approvalAlreadyDecided",
    coreApprovalDenied: "core.approvalDenied",
    coreApprovalExpired: "core.approvalExpired",
    coreApprovalNotFound: "core.approvalNotFound",
    coreApprovalPolicyInvalid: "core.approvalPolicyInvalid",
    coreApprovalRequired: "core.approvalRequired",
    coreInstanceBusy: "core.instanceBusy",
    coreInstanceNotReady: "core.instanceNotReady",
    coreProviderFailed: "core.providerFailed",
    coreToolCallCancelled: "core.toolCallCancelled",
    coreToolQueueTimeout: "core.toolQueueTimeout",
    coreToolSchedulerFull: "core.toolSchedulerFull",
    coreToolSchemaUnavailable: "core.toolSchemaUnavailable",
    coreWorkerAssetUnavailable: "core.workerAssetUnavailable",
    coreWorkerHandshakeFailed: "core.workerHandshakeFailed",
    coreWorkerProvisionFailed: "core.workerProvisionFailed",
    coreWorkerRpcDisconnected: "core.workerRpcDisconnected",
    coreWorkerRpcSpawnFailed: "core.workerRpcSpawnFailed",
    coreWorkerStartFailed: "core.workerStartFailed",
    coreWorkerStatusFailed: "core.workerStatusFailed",
    coreWorkerStopFailed: "core.workerStopFailed",
    coreWorkerTargetProbeFailed: "core.workerTargetProbeFailed",
    coreWorkerTargetUnsupported: "core.workerTargetUnsupported",
    envelopeInvalid: "control.methodNotFound",
    instanceConflict: "instance.conflict",
    instanceAlreadyExists: "control.instanceAlreadyExists",
    instanceMissing: "control.instanceNotFound",
    mcpContextExpired: "mcp.contextExpired",
    mcpContextInstanceMasked: "mcp.contextInstanceMasked",
    mcpContextInvalid: "mcp.contextInvalid",
    mcpContextDisabled: "mcp.contextDisabled",
    mcpContextWorkspaceRequired: "mcp.contextWorkspaceRequired",
    mcpPublicAuthRequired: "mcp.publicAuthRequired",
    protocolFrameTooLarge: "protocol.frameTooLarge",
    protocolVersionUnsupported: "protocol.versionUnsupported",
    reverseConnectionSuperseded: "reverse.connectionSuperseded",
    reverseDeviceCodeConsumed: "reverse.deviceCodeConsumed",
    reverseDeviceCodeExpired: "reverse.deviceCodeExpired",
    reverseDeviceCodeInvalid: "reverse.deviceCodeInvalid",
    reverseDeviceTokenInvalid: "reverse.deviceTokenInvalid",
    reverseDeviceTokenRevoked: "reverse.deviceTokenRevoked",
    reverseFrameInvalid: "reverse.frameInvalid",
    reverseGenerationInvalid: "reverse.generationInvalid",
    reverseInstanceNotReverse: "reverse.instanceNotReverse",
    reverseSelfManagedLifecycle: "reverse.selfManagedLifecycle",
    reverseSelfManagedOffline: "reverse.selfManagedOffline",
    reverseTransportUnavailable: "reverse.transportUnavailable",
    streamGap: "stream.gap",
    targetInvalid: "control.invalidTarget",
    todoInvalid: "todo.invalid",
    todoRevisionConflict: "todo.revisionConflict",
    toolSchemaInvalid: "core.toolSchemaUnavailable",
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];

export interface ControlErrorBody {
    code: string;
    cause?: ControlErrorBody;
    details?: JsonValue;
    message: string;
    retryable: boolean;
}

export interface ControlErrorInit {
    code: string;
    cause?: unknown;
    details?: JsonValue;
    message: string;
    retryable: boolean;
}

export class ControlError extends Error {
    readonly code: string;
    readonly details?: JsonValue;
    readonly retryable: boolean;
    readonly causeBody?: ControlErrorBody;

    constructor(body: ControlErrorInit) {
        super(body.message, body.cause instanceof Error ? { cause: body.cause } : undefined);
        this.name = "ControlError";
        this.code = body.code;
        this.details = body.details;
        this.retryable = body.retryable;
        this.causeBody = toControlErrorBody(body.cause);
    }

    toBody(): ControlErrorBody {
        return {
            code: this.code,
            ...(this.causeBody === undefined ? {} : { cause: this.causeBody }),
            ...(this.details === undefined ? {} : { details: this.details }),
            message: this.message,
            retryable: this.retryable,
        };
    }
}

export function isControlErrorBody(value: unknown): value is ControlErrorBody {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.code === "string"
        && typeof candidate.message === "string"
        && typeof candidate.retryable === "boolean"
        && (candidate.cause === undefined || isControlErrorBody(candidate.cause));
}

export function toControlErrorBody(error: unknown): ControlErrorBody | undefined {
    if (error instanceof ControlError) return error.toBody();
    if (!(error instanceof Error) && isControlErrorBody(error)) return error;
    if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;

    const candidate = error as {
        cause?: unknown;
        code?: unknown;
        details?: JsonValue;
        message?: unknown;
        retryable?: unknown;
    };
    if (typeof candidate.message !== "string") return undefined;

    const cause = toControlErrorBody(candidate.cause);
    return {
        code: typeof candidate.code === "string" ? candidate.code : "error.unknown",
        ...(cause === undefined ? {} : { cause }),
        ...(candidate.details === undefined ? {} : { details: candidate.details }),
        message: candidate.message,
        retryable: typeof candidate.retryable === "boolean" ? candidate.retryable : false,
    };
}

export function createError(body: ControlErrorInit): ControlError {
    return new ControlError(body);
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function toControlError(error: unknown, fallbackCode = errorCodes.targetInvalid): ControlError {
    if (error instanceof ControlError) return error;
    const body = toControlErrorBody(error);
    return createError({
        code: body?.code === undefined || body.code === "error.unknown" ? fallbackCode : body.code,
        ...(body?.details === undefined ? {} : { details: body.details }),
        message: body?.message ?? errorMessage(error),
        retryable: body?.retryable === true,
    });
}
