import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

export function readTodoSubscriptionFromSeq(payload?: JsonValue): number {
    if (!isRecord(payload) || typeof payload.fromSeq !== "number" || !Number.isSafeInteger(payload.fromSeq) || payload.fromSeq < 0) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "todo.subscribe requires a non-negative integer fromSeq.",
            retryable: false
        });
    }
    return payload.fromSeq;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
