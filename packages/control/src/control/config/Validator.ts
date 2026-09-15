import {
    ConfigInputError,
    createError,
    errorCodes,
    formatConfigPath,
    validateConfigSemantics,
    type ControlConfig
} from "@portable-devshell/shared";

export class ControlConfigValidator {
    validate(config: ControlConfig): ControlConfig {
        try {
            return validateConfigSemantics(config);
        } catch (error) {
            if (isStructuredConfigError(error)) throw error;
            if (error instanceof ConfigInputError) {
                throw createError({
                    code: errorCodes.controlConfigValidationFailed,
                    cause: error,
                    details: {
                        fieldPath: formatConfigPath(error.issue.path),
                        phase: error.issue.phase,
                        issueCode: error.issue.code
                    },
                    message: error.message,
                    retryable: false
                });
            }
            throw createError({
                code: errorCodes.controlConfigValidationFailed,
                cause: error,
                details: { phase: "semantic" },
                message: error instanceof Error ? error.message : String(error),
                retryable: false
            });
        }
    }
}

function isStructuredConfigError(error: unknown): error is { code: string } {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}
