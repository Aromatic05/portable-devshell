// Control bounded-context error codes. Control failures cover configuration,
// debug tooling, extension descriptors, reverse enrollment/lifecycle, and
// control-plane instance management. MCP public-plane authentication is
// control-owned too, so it lives here rather than with the interaction
// Context domain. The values are the wire codes carried in RemoteErrorBody.code.

export const controlErrorCodes = {
    cliAccessDenied: "control.cliAccessDenied",
    cliCommandFailed: "control.cliCommandFailed",
    cliCommandInvalid: "control.cliCommandInvalid",
    clientIdentityInvalid: "control.clientIdentityInvalid",
    clientIdentityRequired: "control.clientIdentityRequired",
    configInvalid: "control.configInvalid",
    configLoadFailed: "control.configLoadFailed",
    configParseFailed: "control.configParseFailed",
    configValidationFailed: "control.configValidationFailed",
    debugAccessDenied: "control.debugAccessDenied",
    debugPatchInvalid: "control.debugPatchInvalid",
    debugPatchNotFound: "control.debugPatchNotFound",
    debugTargetNotFound: "control.debugTargetNotFound",
    extensionAccessDenied: "control.extensionAccessDenied",
    extensionFailed: "control.extensionFailed",
    extensionInvalid: "control.extensionInvalid",
    extensionNotActive: "control.extensionNotActive",
    extensionNotFound: "control.extensionNotFound",
    instanceAlreadyExists: "control.instanceAlreadyExists",
    instanceConflict: "instance.conflict",
    instanceNotFound: "control.instanceNotFound",
    invalidTarget: "control.invalidTarget",
    methodNotFound: "control.methodNotFound",
    modelReplyRequired: "control.modelReplyRequired",
    modelResumed: "control.modelResumed",
    modelStopped: "control.modelStopped",
    publicAuthRequired: "mcp.publicAuthRequired",
    restartFailed: "control.restartFailed",
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
    webAccessDenied: "control.webAccessDenied",
} as const;

export type ControlErrorCode =
    (typeof controlErrorCodes)[keyof typeof controlErrorCodes];
