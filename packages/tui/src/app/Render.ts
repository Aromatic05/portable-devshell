import { type TuiAppStore } from "../state/store/App.js";
import { type TuiAppState } from "../state/store/Model.js";

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

export class TuiRenderScheduler {
    readonly #listeners = new Set<() => void>();
    readonly #unsubscribeStore: () => void;
    readonly #flushDelayMs: number;
    #scheduled = false;
    #timer?: NodeJS.Timeout;

    constructor(
        readonly store: TuiAppStore,
        flushDelayMs = 0,
    ) {
        this.#flushDelayMs = flushDelayMs;
        this.#unsubscribeStore = store.subscribe(() => this.schedule());
    }

    getSnapshot(): TuiAppState {
        return this.store.getState();
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /**
     * Subscribes one domain view model as a render source. The returned
     * detacher releases the source, so lazily created per-instance view models
     * can attach on creation and detach on release.
     */
    attach(source: TuiRenderSource): () => void {
        return source.subscribe(() => this.schedule());
    }

    dispose(): void {
        this.#unsubscribeStore();

        if (this.#timer !== undefined) {
            clearTimeout(this.#timer);
            this.#timer = undefined;
        }

        this.#listeners.clear();
        this.#scheduled = false;
    }

    schedule(): void {
        if (this.#scheduled) {
            return;
        }

        this.#scheduled = true;
        this.#timer = setTimeout(() => {
            this.#scheduled = false;
            this.#timer = undefined;

            for (const listener of this.#listeners) {
                listener();
            }
        }, this.#flushDelayMs);
    }
}

export interface TuiRenderSource {
    subscribe(listener: () => void): () => void;
}
