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

export function readTodoTitle(payload?: JsonValue): string | undefined {
    if (payload === undefined) return undefined;
    if (!isRecord(payload)) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "todo.get payload must be an object.",
            retryable: false
        });
    }
    if (payload.title === undefined) return undefined;
    if (typeof payload.title !== "string" || payload.title.trim().length === 0) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "todo.get title must be a non-empty string.",
            retryable: false
        });
    }
    return payload.title;
}

export function readTodoTaskId(payload?: JsonValue): string {
    if (!isRecord(payload) || typeof payload.taskId !== "string" || payload.taskId.trim().length === 0) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "todo.delete taskId must be a non-empty string.",
            retryable: false
        });
    }
    return payload.taskId;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
