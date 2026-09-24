export interface ConfigCommittedChange {
    readonly paths: readonly string[];
}

export class ConfigChangeHub {
    readonly #listeners = new Set<(change: ConfigCommittedChange) => void>();

    onChange(listener: (change: ConfigCommittedChange) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    publish(paths: readonly string[]): void {
        const unique = [...new Set(paths)].sort();
        if (unique.length === 0) return;
        const change = Object.freeze({ paths: Object.freeze(unique) });
        for (const listener of [...this.#listeners]) {
            try {
                listener(change);
            } catch {
                // A committed Config change cannot be rolled back by observers.
            }
        }
    }
}
