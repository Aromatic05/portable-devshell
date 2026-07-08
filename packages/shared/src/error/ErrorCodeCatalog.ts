export const errorCodes = {
    authConfigInvalid: "control.configInvalid",
    coreInstanceBusy: "core.instanceBusy",
    coreInstanceNotReady: "core.instanceNotReady",
    coreProviderFailed: "core.providerFailed",
    coreToolSchemaUnavailable: "core.toolSchemaUnavailable",
    coreWorkerHandshakeFailed: "core.workerHandshakeFailed",
    coreWorkerRpcDisconnected: "core.workerRpcDisconnected",
    coreWorkerStartFailed: "core.workerStartFailed",
    coreWorkerStatusFailed: "core.workerStatusFailed",
    coreWorkerStopFailed: "core.workerStopFailed",
    envelopeInvalid: "control.methodNotFound",
    instanceConflict: "instance.conflict",
    instanceMissing: "control.instanceNotFound",
    mcpPublicAuthRequired: "mcp.publicAuthRequired",
    streamGap: "stream.gap",
    targetInvalid: "control.invalidTarget",
    toolSchemaInvalid: "core.toolSchemaUnavailable"
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];
