export const errorCodes = {
    authConfigInvalid: "config.auth_invalid",
    coreInstanceBusy: "core.instanceBusy",
    envelopeInvalid: "protocol.envelope_invalid",
    instanceConflict: "instance.conflict",
    instanceMissing: "instance.missing",
    streamGap: "stream.gap",
    targetInvalid: "protocol.target_invalid",
    toolSchemaInvalid: "tool.schema_invalid"
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];
