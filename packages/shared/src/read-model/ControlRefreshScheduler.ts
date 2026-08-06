import type { ControlReadModel } from "./ControlReadModel.js";

export type ControlRefreshKind = "oauth" | "overview";

export interface ControlRefreshSchedulerOptions {
    model: ControlReadModel;
    oauthIntervalMs?: number;
    onFailure?(kind: ControlRefreshKind, error: unknown): void;
    onSuccess?(kind: ControlRefreshKind): void;
    overviewIntervalMs?: number;
    shouldRefreshOAuth(): boolean;
    shouldRefreshOverview(): boolean;
}

export class ControlRefreshScheduler {
    readonly #model: ControlReadModel;
    readonly #oauthIntervalMs: number;
    readonly #onFailure?: ControlRefreshSchedulerOptions["onFailure"];
    readonly #onSuccess?: ControlRefreshSchedulerOptions["onSuccess"];
    readonly #overviewIntervalMs: number;
    readonly #shouldRefreshOAuth: () => boolean;
    readonly #shouldRefreshOverview: () => boolean;
    readonly #requests = new Map<ControlRefreshKind, Promise<void>>();
    #oauthTimer?: ReturnType<typeof setInterval>;
    #overviewTimer?: ReturnType<typeof setInterval>;
    #overviewDebounce?: ReturnType<typeof setTimeout>;
    #generation = 0;

    constructor(options: ControlRefreshSchedulerOptions) {
        this.#model = options.model;
        this.#oauthIntervalMs = options.oauthIntervalMs ?? 1_000;
        this.#onFailure = options.onFailure;
        this.#onSuccess = options.onSuccess;
        this.#overviewIntervalMs = options.overviewIntervalMs ?? 5_000;
        this.#shouldRefreshOAuth = options.shouldRefreshOAuth;
        this.#shouldRefreshOverview = options.shouldRefreshOverview;
    }

    start(): void {
        if (this.#oauthTimer === undefined && this.#overviewTimer === undefined) this.#generation += 1;
        if (this.#oauthTimer === undefined && this.#oauthIntervalMs > 0) {
            this.#oauthTimer = setInterval(() => {
                if (this.#shouldRefreshOAuth()) this.#background("oauth");
            }, this.#oauthIntervalMs);
        }
        if (this.#overviewTimer === undefined && this.#overviewIntervalMs > 0) {
            this.#overviewTimer = setInterval(() => {
                if (this.#shouldRefreshOverview()) this.#background("overview");
            }, this.#overviewIntervalMs);
        }
    }

    stop(): void {
        this.#generation += 1;
        if (this.#oauthTimer !== undefined) clearInterval(this.#oauthTimer);
        if (this.#overviewTimer !== undefined) clearInterval(this.#overviewTimer);
        if (this.#overviewDebounce !== undefined) clearTimeout(this.#overviewDebounce);
        this.#oauthTimer = undefined;
        this.#overviewTimer = undefined;
        this.#overviewDebounce = undefined;
        this.#requests.clear();
    }

    scheduleOverview(delayMs: number): void {
        if (this.#overviewDebounce !== undefined) clearTimeout(this.#overviewDebounce);
        this.#overviewDebounce = setTimeout(() => {
            this.#overviewDebounce = undefined;
            if (this.#shouldRefreshOverview()) this.#background("overview");
        }, delayMs);
    }

    #background(kind: ControlRefreshKind): void {
        void this.refresh(kind).catch(() => undefined);
    }

    async refresh(kind: ControlRefreshKind): Promise<void> {
        const active = this.#requests.get(kind);
        if (active !== undefined) return await active;
        const generation = this.#generation;
        const request = (kind === "oauth"
            ? this.#model.refreshOAuth()
            : this.#model.refreshOverview()
        ).then(
            () => { if (generation === this.#generation) this.#onSuccess?.(kind); },
            (error: unknown) => {
                if (generation === this.#generation) this.#onFailure?.(kind, error);
                throw error;
            },
        ).finally(() => {
            if (this.#requests.get(kind) === request) this.#requests.delete(kind);
        });
        this.#requests.set(kind, request);
        return await request;
    }
}
