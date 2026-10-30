import { readToolCallErrorPayload, type JsonValue } from "@portable-devshell/shared";

export interface AgentToolErrorPayload {
    code?: string;
    comment?: string[];
    details?: JsonValue;
    message: string;
    retryable?: boolean;
}

export function encodeAgentToolError(error: unknown): AgentToolErrorPayload {
    const payload: AgentToolErrorPayload = { message: errorMessage(error) };
    if (typeof error !== "object" || error === null) return payload;
    if ("code" in error && typeof error.code === "string")
        payload.code = error.code;
    if ("retryable" in error && typeof error.retryable === "boolean")
        payload.retryable = error.retryable;
    if ("details" in error && isJsonValue(error.details))
        payload.details = error.details;
    // ToolCall's Comment Hook attaches advice to its error payload, not to
    // Error.details. Preserve it across both Agent provider boundaries.
    const attached = readToolCallErrorPayload(error);
    const attachedComment = typeof attached === "object" && attached !== null &&
        !Array.isArray(attached) ? attached.comment : undefined;
    const directComment = "comment" in error ? error.comment : undefined;
    const comment = Array.isArray(attachedComment) ? attachedComment : directComment;
    if (Array.isArray(comment)) {
        const entries = comment.filter(
            (entry): entry is string => typeof entry === "string" && entry.length > 0,
        );
        if (entries.length > 0) payload.comment = entries;
    }
    return payload;
}

// OpenCode's child protocol carries error text. Render the same structured
// facts Pi receives without changing that existing IPC contract.
export function formatAgentToolError(error: unknown): string {
    const payload = encodeAgentToolError(error);
    return [
        payload.code === undefined
            ? payload.message
            : `[${payload.code}] ${payload.message}`,
        ...(payload.retryable === undefined ? [] : [`retryable=${payload.retryable}`]),
        ...(payload.details === undefined ? [] : [`details=${JSON.stringify(payload.details)}`]),
        ...(payload.comment === undefined ? [] : [`comment:\n${payload.comment.join("\n")}`]),
    ].join("\n");
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (
        typeof error === "object" && error !== null &&
        "message" in error && typeof error.message === "string"
    ) return error.message;
    return String(error);
}

function isJsonValue(value: unknown): value is JsonValue {
    return isJsonValueInner(value, new Set<object>());
}

function isJsonValueInner(value: unknown, ancestors: Set<object>): value is JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object") return false;
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    try {
        if (Array.isArray(value))
            return value.every((entry) => isJsonValueInner(entry, ancestors));
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return false;
        return Object.values(value).every((entry) =>
            isJsonValueInner(entry, ancestors),
        );
    } finally {
        ancestors.delete(value);
    }
}
