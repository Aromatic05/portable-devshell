export const errorCodes = {
    authConfigInvalid: "config.auth_invalid",
    envelopeInvalid: "protocol.envelope_invalid",
    instanceConflict: "instance.conflict",
    instanceMissing: "instance.missing",
    targetInvalid: "protocol.target_invalid",
    toolSchemaInvalid: "tool.schema_invalid"
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];
