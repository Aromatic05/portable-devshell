// Runtime bounded-context error codes. These cover the worker/tool/approval
// runtime plus task goals and todos. The values are the wire codes carried in
// RemoteErrorBody.code.

export const runtimeErrorCodes = {
    approvalAlreadyDecided: "core.approvalAlreadyDecided",
    approvalDenied: "core.approvalDenied",
    approvalExpired: "core.approvalExpired",
    approvalNotFound: "core.approvalNotFound",
    approvalPolicyInvalid: "core.approvalPolicyInvalid",
    approvalRequired: "core.approvalRequired",
    instanceBusy: "core.instanceBusy",
    instanceConflict: "instance.conflict",
    instanceNotReady: "core.instanceNotReady",
    providerFailed: "core.providerFailed",
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
    todoInvalid: "todo.invalid",
    todoRevisionConflict: "todo.revisionConflict",
    toolCallCancelled: "core.toolCallCancelled",
    toolCallRejected: "core.toolCallRejected",
    toolQueueTimeout: "core.toolQueueTimeout",
    toolSchedulerFull: "core.toolSchedulerFull",
    toolSchemaUnavailable: "core.toolSchemaUnavailable",
    workerAssetUnavailable: "core.workerAssetUnavailable",
    workerHandshakeFailed: "core.workerHandshakeFailed",
    workerProvisionFailed: "core.workerProvisionFailed",
    workerRpcSpawnFailed: "core.workerRpcSpawnFailed",
    workerStartFailed: "core.workerStartFailed",
    workerStatusFailed: "core.workerStatusFailed",
    workerStopFailed: "core.workerStopFailed",
    workerTargetProbeFailed: "core.workerTargetProbeFailed",
    workerTargetUnsupported: "core.workerTargetUnsupported",
    workerTransportDisconnected: "core.workerTransportDisconnected",
} as const;

export type RuntimeErrorCode =
    (typeof runtimeErrorCodes)[keyof typeof runtimeErrorCodes];
