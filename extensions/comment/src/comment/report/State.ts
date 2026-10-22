import {
    COMMENT_REPORT_BUCKET_CAPACITY,
    COMMENT_REPORT_REFILL_INTERVAL_MS,
    refillBucket,
} from "./Policy.js";

export interface CommentReportBucketState {
    lastRefillAt: number;
    lastReportMessage?: string;
    tokens: number;
}

export class CommentReportState {
    readonly #report = new Map<string, CommentReportBucketState>();
    readonly #reportOperations = new Map<string, Promise<void>>();

    async withReport<T>(
        ctxId: string,
        now: () => number,
        operation: (state: CommentReportBucketState) => Promise<T>,
    ): Promise<T> {
        return await this.#withLock(this.#reportOperations, ctxId, async () => {
            const timestamp = now();
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
