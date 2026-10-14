import type { JsonValue, TodoReadInput } from "@portable-devshell/shared";

interface TodoToolReadInput extends TodoReadInput {
    offset?: number;
    limit?: number;
}

export function readTodoToolInput(input: JsonValue): TodoToolReadInput | undefined {
    if (typeof input !== "object" || input === null || Array.isArray(input))
        throw new Error("todo_read requires an object input.");
    const keys = Object.keys(input);
    if (keys.length === 0) return undefined;
    if (keys.some((key) => !["taskId", "offset", "limit"].includes(key)))
        throw new Error(
            "todo_read accepts only taskId, offset, and limit selectors.",
        );
    const value = input.taskId;
    if (value !== undefined &&
        (typeof value !== "string" || value.trim().length === 0))
        throw new Error("todo_read taskId must be a non-empty string.");
    const offset = input.offset;
    if (offset !== undefined &&
        (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0))
        throw new Error("todo_read offset must be a nonnegative integer.");
    const limit = input.limit;
    if (limit !== undefined &&
        (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100))
        throw new Error("todo_read limit must be between 1 and 100.");
    return {
        ...(typeof value === "string" ? { taskId: value.trim() } : {}),
        ...(typeof offset === "number" ? { offset } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
    };
}
