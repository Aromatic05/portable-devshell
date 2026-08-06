import { ControlError, toControlErrorBody, type ControlErrorInit } from "./ErrorBodyControl.js";
import { errorCodes } from "./ErrorCodeCatalog.js";

export function createError(body: ControlErrorInit): ControlError {
    return new ControlError(body);
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function toControlError(
    error: unknown,
    fallbackCode = errorCodes.targetInvalid,
): ControlError {
    if (error instanceof ControlError) return error;
    const body = toControlErrorBody(error);
    return createError({
        code: body?.code === undefined || body.code === "error.unknown"
            ? fallbackCode
            : body.code,
        ...(body?.details === undefined ? {} : { details: body.details }),
        message: body?.message ?? errorMessage(error),
        retryable: body?.retryable === true,
    });
}
