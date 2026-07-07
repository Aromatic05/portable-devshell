export const errorCodes = {
    authConfigInvalid: "config.auth_invalid",
    coreInstanceBusy: "core.instanceBusy",
    coreInstanceNotReady: "core.instanceNotReady",
    coreProviderFailed: "core.providerFailed",
    coreToolSchemaUnavailable: "core.toolSchemaUnavailable",
    coreWorkerHandshakeFailed: "core.workerHandshakeFailed",
    coreWorkerRpcDisconnected: "core.workerRpcDisconnected",
    coreWorkerStartFailed: "core.workerStartFailed",
    coreWorkerStatusFailed: "core.workerStatusFailed",
    coreWorkerStopFailed: "core.workerStopFailed",
    envelopeInvalid: "protocol.envelope_invalid",
    instanceConflict: "instance.conflict",
    instanceMissing: "instance.missing",
    streamGap: "stream.gap",
    targetInvalid: "protocol.target_invalid",
    toolSchemaInvalid: "tool.schema_invalid"
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];
