export interface TuiViewportSnapshot {
    columns: number;
    rows: number;
}

export interface TuiViewportRenderSource {
    getSnapshot(): TuiViewportSnapshot;
    subscribe(listener: () => void): () => void;
}

export class TuiViewport implements TuiViewportRenderSource {
    readonly #listeners = new Set<() => void>();
    #snapshot: TuiViewportSnapshot;

    constructor(snapshot: TuiViewportSnapshot) {
        this.#snapshot = normalizeViewport(snapshot);
    }

    getSnapshot(): TuiViewportSnapshot {
        return this.#snapshot;
    }

    resize(columns: number, rows: number): boolean {
        const next = normalizeViewport({ columns, rows });
        if (
            next.columns === this.#snapshot.columns &&
            next.rows === this.#snapshot.rows
        ) {
            return false;
        }
        this.#snapshot = next;
        for (const listener of this.#listeners) listener();
        return true;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
}

function normalizeViewport(viewport: TuiViewportSnapshot): TuiViewportSnapshot {
    return {
        columns: Math.max(1, Math.floor(viewport.columns)),
        rows: Math.max(1, Math.floor(viewport.rows)),
    };
}
