import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

export function readReverseInstanceName(params?: JsonValue): string {
    if (!isRecord(params) || typeof params.instance !== "string" || params.instance.length === 0) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "Reverse connection operation requires instance.",
            retryable: false
        });
    }
    return params.instance;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
