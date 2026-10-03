// Committed Config change feed. One committed mutation is the sorted,
// de-duplicated set of Config paths it touched. Every publish advances a
// monotonic revision and is retained in a bounded replay history so a
// subscriber can resume from a revision it already observed. `onChange` stays
// the unbounded live notification used by in-process observers such as
// extension Config capabilities; the revision/replay surface is additive.

export interface ConfigCommittedChange {
    readonly paths: readonly string[];
    readonly revision: number;
}

export interface ConfigChangeSlice {
    readonly changes: readonly ConfigCommittedChange[];
    readonly kind: "events" | "gap";
    /** Latest committed revision, whether or not it is still buffered. */
    readonly latestRevision: number;
    /** Oldest revision still buffered, or latest + 1 when nothing is buffered. */
    readonly oldestAvailableRevision: number;
}

export interface ConfigChangeHubOptions {
    historyLimit?: number;
}

const DEFAULT_HISTORY_LIMIT = 128;

export class ConfigChangeHub {
    readonly #history: ConfigCommittedChange[] = [];
    readonly #historyLimit: number;
    readonly #listeners = new Set<(change: ConfigCommittedChange) => void>();
    #revision = 0;

    constructor(options: ConfigChangeHubOptions = {}) {
        const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
        if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) {
            throw new TypeError(
                "Config change history limit must be a positive integer.",
            );
        }
        this.#historyLimit = historyLimit;
    }

    get revision(): number {
        return this.#revision;
    }

    onChange(listener: (change: ConfigCommittedChange) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    publish(paths: readonly string[]): number {
        const unique = [...new Set(paths)].sort();
        if (unique.length === 0) return this.#revision;
        this.#revision += 1;
        const change = Object.freeze({
            paths: Object.freeze(unique),
            revision: this.#revision,
        });
        this.#history.push(change);
        if (this.#history.length > this.#historyLimit) this.#history.shift();
        for (const listener of [...this.#listeners]) {
            try {
                listener(change);
            } catch {
                // A committed Config change cannot be rolled back by observers.
            }
        }
        return this.#revision;
    }

    /**
     * Replays buffered changes from `fromRevision` (inclusive). When the
     * requested revision has already fallen out of the bounded buffer the
     * result is a gap carrying the resume boundary instead of partial events.
     */
    readSince(fromRevision: number): ConfigChangeSlice {
        const requested = Math.max(1, fromRevision);
        const oldestAvailableRevision =
            this.#history[0]?.revision ?? this.#revision + 1;
        if (requested < oldestAvailableRevision) {
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
