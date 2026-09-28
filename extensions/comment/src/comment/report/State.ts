import {
    COMMENT_REPORT_BUCKET_CAPACITY,
    COMMENT_REPORT_REFILL_INTERVAL_MS,
    COMMENT_TODO_ACCESS_BUCKET_CAPACITY,
    COMMENT_TODO_ACCESS_REFILL_INTERVAL_MS,
    COMMENT_TODO_INVALID_DISABLE_MS,
    COMMENT_TODO_INVALID_LIMIT,
    COMMENT_TODO_INVALID_WINDOW_MS,
    refillBucket,
    todoUseOtherToolsError,
} from "./Policy.js";

export interface CommentReportBucketState {
    lastRefillAt: number;
    lastReportMessage?: string;
    tokens: number;
}

interface TodoAccessPolicyState {
    lastRefillAt: number;
    tokens: number;
}

interface TodoInvalidPolicyState {
    disabledUntil?: number;
    invalidAt: number[];
}

export class CommentReportState {
    readonly #access = new Map<string, TodoAccessPolicyState>();
    readonly #accessOperations = new Map<string, Promise<void>>();
    readonly #invalid = new Map<string, TodoInvalidPolicyState>();
    readonly #report = new Map<string, CommentReportBucketState>();
    readonly #reportOperations = new Map<string, Promise<void>>();

    assertTodoEnabled(ctxId: string, now: number): void {
        const state = this.#invalid.get(ctxId);
        if (state === undefined) return;
        if (state.disabledUntil !== undefined) {
            if (now < state.disabledUntil) throw todoUseOtherToolsError();
            this.#invalid.delete(ctxId);
            return;
        }
        state.invalidAt = state.invalidAt.filter(
            (timestamp) => now - timestamp < COMMENT_TODO_INVALID_WINDOW_MS,
        );
        if (state.invalidAt.length === 0) this.#invalid.delete(ctxId);
    }

    recordInvalid(ctxId: string, now: number): void {
        const previous = this.#invalid.get(ctxId);
        if (
            previous?.disabledUntil !== undefined &&
            now < previous.disabledUntil
        ) {
            return;
        }
        const invalidAt = (previous?.invalidAt ?? []).filter(
            (timestamp) => now - timestamp < COMMENT_TODO_INVALID_WINDOW_MS,
        );
        invalidAt.push(now);
        this.#invalid.set(
            ctxId,
            invalidAt.length >= COMMENT_TODO_INVALID_LIMIT
                ? {
                      disabledUntil: now + COMMENT_TODO_INVALID_DISABLE_MS,
                      invalidAt: [],
                  }
                : { invalidAt },
        );
    }

    async consumeTodoAccess(ctxId: string, now: number): Promise<void> {
        await this.#withLock(this.#accessOperations, ctxId, async () => {
            this.assertTodoEnabled(ctxId, now);
            const current = this.#access.get(ctxId) ?? {
                lastRefillAt: now,
                tokens: COMMENT_TODO_ACCESS_BUCKET_CAPACITY,
            };
            const refill = refillBucket(
                current.tokens,
                current.lastRefillAt,
                now,
                COMMENT_TODO_ACCESS_BUCKET_CAPACITY,
                COMMENT_TODO_ACCESS_REFILL_INTERVAL_MS,
            );
            current.lastRefillAt = refill.lastRefillAt;
            current.tokens = refill.tokens;
            this.#access.set(ctxId, current);
            if (current.tokens < 1) {
                this.recordInvalid(ctxId, now);
                throw todoUseOtherToolsError();
            }
            current.tokens -= 1;
        });
    }

    async withReport<T>(
        ctxId: string,
        now: () => number,
        operation: (state: CommentReportBucketState) => Promise<T>,
    ): Promise<T> {
        return await this.#withLock(this.#reportOperations, ctxId, async () => {
            const timestamp = now();
            this.assertTodoEnabled(ctxId, timestamp);
            const current = this.#report.get(ctxId) ?? {
                lastRefillAt: timestamp,
                tokens: COMMENT_REPORT_BUCKET_CAPACITY,
            };
            const refill = refillBucket(
                current.tokens,
                current.lastRefillAt,
                timestamp,
                COMMENT_REPORT_BUCKET_CAPACITY,
                COMMENT_REPORT_REFILL_INTERVAL_MS,
            );
            current.lastRefillAt = refill.lastRefillAt;
            current.tokens = refill.tokens;
            this.#report.set(ctxId, current);
            return await operation(current);
        });
    }

    async #withLock<T>(
        operations: Map<string, Promise<void>>,
        key: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        const previous = operations.get(key) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const current = previous
            .catch(() => undefined)
            .then(async () => await gate);
        operations.set(key, current);
        await previous.catch(() => undefined);
        try {
            return await operation();
        } finally {
            release();
            if (operations.get(key) === current) operations.delete(key);
        }
    }
}
