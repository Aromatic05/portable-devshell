import type { JsonValue, TodoReadInput } from "@portable-devshell/shared";

export function readTodoToolInput(input: JsonValue): TodoReadInput | undefined {
    if (typeof input !== "object" || input === null || Array.isArray(input))
        throw new Error("todo_read requires an object input.");
    const keys = Object.keys(input);
    if (keys.length === 0) return undefined;
    if (keys.length !== 1 || keys[0] !== "taskId")
        throw new Error(
            "todo_read accepts only the optional taskId selector.",
        );
    const value = input.taskId;
    if (typeof value !== "string" || value.trim().length === 0)
        throw new Error("todo_read taskId must be a non-empty string.");
    return { taskId: value.trim() };
}
