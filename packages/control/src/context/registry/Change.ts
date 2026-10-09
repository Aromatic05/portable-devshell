
export interface ContextCommittedChange {
    readonly ctxIds: readonly string[];
    readonly terminalCtxIds?: readonly string[];
    readonly revision: number;
}

export interface ContextChangeSlice {
    readonly changes: readonly ContextCommittedChange[];
    readonly kind: "events" | "gap";
    /** Latest committed revision, whether or not it is still buffered. */
    readonly latestRevision: number;
    /** Oldest revision still buffered, or latest + 1 when nothing is buffered. */
    readonly oldestAvailableRevision: number;
}

export interface ContextChangeHubOptions {
    historyLimit?: number;
}

const DEFAULT_HISTORY_LIMIT = 128;

export class ContextChangeHub {
    readonly #history: ContextCommittedChange[] = [];
    readonly #historyLimit: number;
    readonly #listeners = new Set<(change: ContextCommittedChange) => void>();
    #revision = 0;

    constructor(options: ContextChangeHubOptions = {}) {
        const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
        if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) {
            throw new TypeError(
                "Context change history limit must be a positive integer.",
            );
        }
        this.#historyLimit = historyLimit;
    }

    get revision(): number {
        return this.#revision;
    }

    onChange(listener: (change: ContextCommittedChange) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    publish(ctxIds: readonly string[], terminalCtxIds: readonly string[] = []): number {
        const unique = [...new Set(ctxIds)].sort();
        if (unique.length === 0) return this.#revision;
        this.#revision += 1;
        const change = Object.freeze({
            ctxIds: Object.freeze(unique),
            ...(terminalCtxIds.length === 0 ? {} : { terminalCtxIds: Object.freeze([...new Set(terminalCtxIds)]) }),
            revision: this.#revision,
        });
        this.#history.push(change);
        if (this.#history.length > this.#historyLimit) this.#history.shift();
        for (const listener of [...this.#listeners]) {
            try {
                listener(change);
            } catch {
                // Listener failures do not block other Context observers.
            }
        }
        return this.#revision;
    }

    /**
     * Replays buffered changes from `fromRevision` (inclusive). When the
     * requested revision has already fallen out of the bounded buffer the
     * result is a gap carrying the resume boundary instead of partial events.
     */
    readSince(fromRevision: number): ContextChangeSlice {
        const requested = Math.max(1, fromRevision);
        const oldestAvailableRevision =
            this.#history[0]?.revision ?? this.#revision + 1;
        if (
            requested < oldestAvailableRevision ||
            requested > this.#revision + 1
        ) {
            return Object.freeze({
                changes: Object.freeze([]),
                kind: "gap",
                latestRevision: this.#revision,
                oldestAvailableRevision,
            });
        }
        return Object.freeze({
            changes: Object.freeze(
                this.#history.filter((change) => change.revision >= requested),
            ),
            kind: "events",
            latestRevision: this.#revision,
            oldestAvailableRevision,
        });
    }
}
