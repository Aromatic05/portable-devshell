// Stateful operational overview projection. Owns the latest immutable
// OperationalOverview snapshot and a stable subscribe/getSnapshot surface for
// useSyncExternalStore/TUI consumers. It owns its own refresh policy: an
// explicit refresh with stale-generation protection, an optional start/stop
// periodic cadence (the historical 5s default, configurable), and a debounced
// scheduleRefresh for event-driven callers. Failures are domain-local to this
// snapshot, and a missing overview operation settles into an explicit
// unsupported state instead of surfacing as an error.

import type { OperationalOverview } from "./Model.js";
import type { OverviewTransport } from "./Transport.js";

export type OverviewViewModelStatus =
    "idle" | "ready" | "unsupported" | "failed";

export interface OverviewViewModelState {
    failure?: Error;
    overview?: OperationalOverview;
    status: OverviewViewModelStatus;
}

export interface OverviewViewModelOptions {
    /**
     * Periodic auto-refresh cadence. Defaults to the historical 5s; 0 disables
     * the interval.
     */
    refreshIntervalMs?: number;

    /** Coalescing delay for scheduleRefresh. Defaults to 100ms. */
    scheduleDelayMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 5_000;
const DEFAULT_SCHEDULE_DELAY_MS = 100;
const METHOD_NOT_FOUND_CODE = "method_not_found";

export class OverviewViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #transport: OverviewTransport;
    readonly #refreshIntervalMs: number;
    readonly #scheduleDelayMs: number;
    #generation = 0;
    #intervalTimer?: ReturnType<typeof setInterval>;
    #published: Readonly<OverviewViewModelState> = emptyState();
    #refresh?: Promise<void>;
    #refreshRequested = false;
    #refreshTimer?: ReturnType<typeof setTimeout>;
    #state: OverviewViewModelState = emptyState();

    constructor(
        transport: OverviewTransport,
        options: OverviewViewModelOptions = {},
    ) {
        this.#transport = transport;
        this.#refreshIntervalMs =
            options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
        this.#scheduleDelayMs =
            options.scheduleDelayMs ?? DEFAULT_SCHEDULE_DELAY_MS;
    }

    get state(): Readonly<OverviewViewModelState> {
        return this.#published;
    }

    getSnapshot(): Readonly<OverviewViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    refresh(): Promise<void> {
        if (this.#refresh !== undefined) {
            this.#refreshRequested = true;
            return this.#refresh;
        }
        const generation = this.#generation;
        const pending = this.#runRefreshLoop(generation).finally(() => {
            if (this.#refresh === pending) this.#refresh = undefined;
        });
        this.#refresh = pending;
        return pending;
    }

    async #runRefreshLoop(generation: number): Promise<void> {
        do {
            this.#refreshRequested = false;
            await this.#refreshOnce(generation);
        } while (this.#refreshRequested && generation === this.#generation);
    }

    async #refreshOnce(generation: number): Promise<void> {
        try {
            const overview = await this.#transport.get();
            if (generation !== this.#generation) return;
            this.#state = { overview, status: "ready" };
        } catch (error) {
            if (generation !== this.#generation) return;
            this.#state = isMethodNotFound(error)
                ? { status: "unsupported" }
                : {
                      ...this.#state,
                      failure: toError(error),
                      status: "failed",
                  };
        }
        this.#emit();
    }

    /**
     * Coalesces event-driven refresh requests into one trailing call. Callers
     * keep control of the near-term delay; later calls replace the pending one.
     */
    scheduleRefresh(delayMs = this.#scheduleDelayMs): void {
        if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
        this.#refreshTimer = setTimeout(() => {
            this.#refreshTimer = undefined;
            void this.refresh();
        }, delayMs);
    }

    /** Arms the optional periodic refresh cadence. Safe to call repeatedly. */
    start(): void {
        if (this.#intervalTimer !== undefined || this.#refreshIntervalMs <= 0)
            return;
        this.#intervalTimer = setInterval(() => {
            void this.refresh();
        }, this.#refreshIntervalMs);
    }

    /** Disarms auto-refresh without discarding the current snapshot. */
    stop(): void {
        if (this.#intervalTimer !== undefined) {
            clearInterval(this.#intervalTimer);
            this.#intervalTimer = undefined;
        }
        if (this.#refreshTimer !== undefined) {
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = undefined;
        }
    }

    close(): void {
        this.stop();
        this.#generation += 1;
        this.#refreshRequested = false;
        this.#listeners.clear();
        this.#state = emptyState();
        this.#published = this.#state;
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = { ...this.#state };
        for (const listener of this.#listeners) listener();
    }
}

function emptyState(): OverviewViewModelState {
    return { status: "idle" };
}

function isMethodNotFound(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === METHOD_NOT_FOUND_CODE
    );
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
