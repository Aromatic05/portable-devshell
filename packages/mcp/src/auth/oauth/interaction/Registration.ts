export interface McpOAuthRegistrationLimiterOptions {
    maxKeys?: number;
    maxRequests?: number;
    now?: () => number;
    windowMs?: number;
}

const defaultMaxKeys = 1024;
const defaultMaxRequests = 20;
const defaultWindowMs = 60_000;

export class McpOAuthRegistrationLimiter {
    readonly #entries = new Map<string, number[]>();
    readonly #maxKeys: number;
    readonly #maxRequests: number;
    readonly #now: () => number;
    readonly #windowMs: number;

    constructor(options: McpOAuthRegistrationLimiterOptions = {}) {
        this.#maxKeys = positiveInteger(options.maxKeys, defaultMaxKeys, "maxKeys");
        this.#maxRequests = positiveInteger(options.maxRequests, defaultMaxRequests, "maxRequests");
        this.#now = options.now ?? Date.now;
        this.#windowMs = positiveInteger(options.windowMs, defaultWindowMs, "windowMs");
    }

    accept(key: string): boolean {
        const now = this.#now();
        const cutoff = now - this.#windowMs;
        this.#pruneKeys(cutoff);
        let timestamps = this.#entries.get(key);
        if (timestamps === undefined) {
            if (this.#entries.size >= this.#maxKeys) {
                this.#evictOldestKey();
            }
            timestamps = [];
            this.#entries.set(key, timestamps);
        }
        while (timestamps.length > 0 && timestamps[0]! <= cutoff) {
            timestamps.shift();
        }
        if (timestamps.length >= this.#maxRequests) {
            return false;
        }
        timestamps.push(now);
        return true;
    }

    #pruneKeys(cutoff: number): void {
        for (const [key, timestamps] of this.#entries) {
            while (timestamps.length > 0 && timestamps[0]! <= cutoff) {
                timestamps.shift();
            }
            if (timestamps.length === 0) {
                this.#entries.delete(key);
            }
        }
    }

    #evictOldestKey(): void {
        let oldestKey: string | undefined;
        let oldestTimestamp = Number.POSITIVE_INFINITY;
        for (const [key, timestamps] of this.#entries) {
            const timestamp = timestamps[0] ?? Number.NEGATIVE_INFINITY;
            if (timestamp < oldestTimestamp) {
                oldestTimestamp = timestamp;
                oldestKey = key;
            }
        }
        if (oldestKey !== undefined) {
            this.#entries.delete(oldestKey);
        }
    }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return resolved;
}
