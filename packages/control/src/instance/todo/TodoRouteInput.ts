import { createError, errorCodes, type JsonValue, type TodoReadInput } from "@portable-devshell/shared";

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

export function readTodoInput(payload?: JsonValue): TodoReadInput | undefined {
    if (payload === undefined) return undefined;
    if (!isRecord(payload)) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "todo.get payload must be an object.",
            retryable: false
        });
    }
    const keys = Object.keys(payload);
    if (keys.length === 0) return undefined;
    if (keys.length !== 1 || (keys[0] !== "taskId" && keys[0] !== "title")) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "todo.get accepts only one optional selector: taskId or title.",
            retryable: false
        });
    }
    const key = keys[0] as "taskId" | "title";
    const value = payload[key];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: `todo.get ${key} must be a non-empty string.`,
            retryable: false
        });
    }
    return { [key]: value.trim() };
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
