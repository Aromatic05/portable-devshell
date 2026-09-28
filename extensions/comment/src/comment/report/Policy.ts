import { ExtensionError } from "@portable-devshell/extension";

export const COMMENT_REPORT_BUCKET_CAPACITY = 2;
export const COMMENT_REPORT_REFILL_INTERVAL_MS = 30_000;
export const COMMENT_REPORT_CONVERSATION_WINDOW = 400;
export const COMMENT_TODO_ACCESS_BUCKET_CAPACITY = 2;
export const COMMENT_TODO_ACCESS_REFILL_INTERVAL_MS = 30_000;
export const COMMENT_TODO_INVALID_WINDOW_MS = 120_000;
export const COMMENT_TODO_INVALID_DISABLE_MS = 300_000;
export const COMMENT_TODO_INVALID_LIMIT = 3;

export function refillBucket(
    tokens: number,
    lastRefillAt: number,
    now: number,
    capacity: number,
    intervalMs: number,
): { lastRefillAt: number; tokens: number } {
    const elapsed = Math.max(0, now - lastRefillAt);
    return {
        lastRefillAt: now,
        tokens: Math.min(capacity, tokens + elapsed / intervalMs),
    };
}

export function duplicateReportError(ctxId: string): Error {
    return new ExtensionError({
        code: "todo.invalid",
        details: { ctxId, reason: "duplicate" },
        message:
            "todo_report rejected an unchanged consecutive report. Continue useful work until there is new information.",
        retryable: false,
    });
}

export function todoUseOtherToolsError(): Error {
    return new ExtensionError({
        code: "todo.invalid",
        details: { action: "use_other_tools" },
        message:
            "You have performed too many useless operations. Use other tools.",
        retryable: false,
    });
}
