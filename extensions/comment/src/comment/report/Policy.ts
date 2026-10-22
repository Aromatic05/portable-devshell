import { ExtensionError } from "@portable-devshell/extension";

export const COMMENT_REPORT_BUCKET_CAPACITY = 2;
export const COMMENT_REPORT_REFILL_INTERVAL_MS = 30_000;
export const COMMENT_REPORT_CONVERSATION_WINDOW = 400;

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
        code: "progress.duplicate",
        details: { ctxId, reason: "duplicate" },
        message:
            "progress_report rejected an unchanged consecutive report. Continue useful work until there is new information.",
        retryable: false,
    });
}

export function reportRateLimitError(): Error {
    return new ExtensionError({
        code: "progress.rateLimited",
        details: { reason: "rate_limited" },
        message:
            "Too many progress reports. Continue useful work before reporting again.",
        retryable: false,
    });
}
