import type { TuiAppStore } from "../store/TuiAppStore.js";
import type { TuiAppState } from "../store/TuiStoreTypes.js";

export class TuiRenderScheduler {
    readonly #listeners = new Set<() => void>();
    readonly #unsubscribeStore: () => void;
    readonly #flushDelayMs: number;
    #scheduled = false;
    #timer?: NodeJS.Timeout;

    constructor(readonly store: TuiAppStore, flushDelayMs = 16) {
        this.#flushDelayMs = flushDelayMs;
        this.#unsubscribeStore = store.subscribe(() => {
            this.#schedule();
        });
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

    dispose(): void {
        this.#unsubscribeStore();

        if (this.#timer !== undefined) {
            clearTimeout(this.#timer);
            this.#timer = undefined;
        }

        this.#listeners.clear();
        this.#scheduled = false;
    }

    #schedule(): void {
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
