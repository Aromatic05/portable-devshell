import {
    TODO_MAX_TEXT_LENGTH,
    type JsonValue,
    type TodoReadInput,
} from "@portable-devshell/shared";

export function readTodoReportMessage(input: JsonValue): string {
    if (typeof input !== "object" || input === null || Array.isArray(input))
        throw new Error("todo_report requires an object input.");
    const keys = Object.keys(input);
    if (keys.length !== 1 || keys[0] !== "message")
        throw new Error("todo_report accepts only message.");
    const value = input.message;
    if (typeof value !== "string" || value.trim().length === 0)
        throw new Error("todo_report message must be a non-empty string.");
    const message = value.trim();
    if (message.length > TODO_MAX_TEXT_LENGTH)
        throw new Error(
            `todo_report message must be at most ${TODO_MAX_TEXT_LENGTH} characters.`,
        );
    return message;
}

export function readTodoInput(input: JsonValue): TodoReadInput | undefined {
    if (typeof input !== "object" || input === null || Array.isArray(input))
        throw new Error("todo_read requires an object input.");
    const keys = Object.keys(input);
    if (keys.length === 0) return undefined;
    if (keys.length !== 1 || (keys[0] !== "taskId" && keys[0] !== "title"))
        throw new Error(
            "todo_read accepts only one optional selector: taskId or title.",
        );
    const key = keys[0] as "taskId" | "title";
    const value = input[key];
    if (typeof value !== "string" || value.trim().length === 0)
        throw new Error(`todo_read ${key} must be a non-empty string.`);
    return { [key]: value.trim() };
}
