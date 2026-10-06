import type { ExtensionChangeEvent } from "@portable-devshell/shared";

export interface ExtensionChangeSlice {
    readonly changes: readonly ExtensionChangeEvent[];
    readonly kind: "events" | "gap";
    readonly latestRevision: number;
    readonly oldestAvailableRevision: number;
}

export class ExtensionChangeHub {
    readonly #history: ExtensionChangeEvent[] = [];
    readonly #historyLimit: number;
    readonly #listeners = new Set<(change: ExtensionChangeEvent) => void>();
    #revision = 0;

    constructor(options: { historyLimit?: number } = {}) {
        const limit = options.historyLimit ?? 128;
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new TypeError("Extension change history limit must be a positive integer.");
        this.#historyLimit = limit;
    }

    get revision(): number {
        return this.#revision;
    }

    onChange(listener: (change: ExtensionChangeEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    publish(extensionIds: readonly string[]): number {
        const unique = [...new Set(extensionIds)].sort();
        if (unique.length === 0) return this.#revision;
        this.#revision += 1;
        const change = Object.freeze({
            extensionIds: Object.freeze(unique),
            revision: this.#revision,
        });
        this.#history.push(change);
        if (this.#history.length > this.#historyLimit) this.#history.shift();
        for (const listener of [...this.#listeners]) {
            try {
                listener(change);
            } catch {
                continue;
            }
        }
        return this.#revision;
    }

    readSince(fromRevision: number): ExtensionChangeSlice {
        const requested = Math.max(1, fromRevision);
        const oldestAvailableRevision = this.#history[0]?.revision ?? this.#revision + 1;
        const kind = requested < oldestAvailableRevision ? "gap" : "events";
        return Object.freeze({
            changes: Object.freeze(kind === "gap" ? [] : this.#history.filter(
                (change) => change.revision >= requested,
            )),
            kind,
            latestRevision: this.#revision,
            oldestAvailableRevision,
        });
    }
}
