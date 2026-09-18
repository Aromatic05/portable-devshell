import type { ToolCallReviewInvocation } from "@portable-devshell/extension/toolcall";
import type { ControlErrorBody, JsonValue } from "@portable-devshell/shared";

import { mergeComments } from "../comment/Merge.js";
import { resolveErrorHints, resolveResultHints } from "./Resolver.js";

export function resolveToolCallFeedback(
    input: ToolCallReviewInvocation,
): readonly string[] {
    if (input.direction !== "outbound") return [];
    if (input.kind === "result") {
        return mergeComments(
            [],
            resolveResultHints(input.toolName, input.payload as JsonValue),
        );
    }
    if (input.kind !== "error") return [];
    const body = readErrorBody(input.payload);
    return body === undefined
        ? []
        : mergeComments([], resolveErrorHints(input.toolName, body));
}

function readErrorBody(value: JsonValue): ControlErrorBody | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const error = value.error;
    if (typeof error !== "object" || error === null || Array.isArray(error))
        return undefined;
    if (
        typeof error.code !== "string" ||
        typeof error.message !== "string" ||
        typeof error.retryable !== "boolean"
    ) {
        return undefined;
    }
    return error as unknown as ControlErrorBody;
}
