import type { OperationalOverview } from "@portable-devshell/shared/browser";

import type { WebClients } from "../client/WebClients.js";
import type { WebState } from "./WebState.js";
import { withWebRequestTimeout } from "./WebRequestTimeout.js";

export interface OperationalOverviewAccess {
    currentGeneration(): number;
    getState(): WebState;
    isCurrent(generation: number): boolean;
    isVisible(): boolean;
    setState(state: WebState): void;
}

export class OperationalOverviewCoordinator {
    #scheduled?: ReturnType<typeof setTimeout>;
    #poll?: ReturnType<typeof setInterval>;
    #request?: Promise<void>;
    #requestGeneration?: number;
    #version = 0;
    #observed = false;
    #online = false;

    constructor(
        private readonly clients: WebClients,
        private readonly access: OperationalOverviewAccess,
        private readonly refreshIntervalMs: number,
        private readonly requestTimeoutMs = 10_000,
    ) {}

    setObserved(observed: boolean): void {
        this.#observed = observed;
        this.reconcilePolling();
    }

    setOnline(online: boolean): void {
        this.#online = online;
        this.reconcilePolling();
    }

    schedule(generation: number): void {
        if (this.#scheduled !== undefined) return;
        this.#scheduled = setTimeout(() => {
            this.#scheduled = undefined;
            void this.refresh(generation);
        }, 250);
    }

    async refresh(generation: number, force = false): Promise<void> {
        if (
            !force &&
            this.#request !== undefined &&
            this.#requestGeneration === generation
        ) return await this.#request;
        this.#requestGeneration = generation;
        const version = ++this.#version;
        const request = withWebRequestTimeout(
            this.clients.overview.get(),
            this.requestTimeoutMs,
            "overview",
        )
            .then((overview) => this.applyOverview(overview, generation, version))
            .catch((error: unknown) => this.applyFailure(error, generation, version))
            .finally(() => {
                if (this.#request === request) {
                    this.#request = undefined;
                    this.#requestGeneration = undefined;
                }
            });
        this.#request = request;
        return await request;
    }

    clearScheduled(): void {
        if (this.#scheduled !== undefined) {
            clearTimeout(this.#scheduled);
            this.#scheduled = undefined;
        }
    }

    stop(): void {
        this.clearScheduled();
        if (this.#poll !== undefined) {
            clearInterval(this.#poll);
            this.#poll = undefined;
        }
    }

    private reconcilePolling(): void {
        const shouldPoll =
            this.#observed &&
            this.#online &&
            this.refreshIntervalMs > 0;
        if (!shouldPoll) {
            if (this.#poll !== undefined) {
                clearInterval(this.#poll);
                this.#poll = undefined;
            }
            return;
        }
        if (this.#poll !== undefined) return;
        this.#poll = setInterval(() => {
            if (this.#online && this.access.isVisible()) {
                void this.refresh(this.access.currentGeneration());
            }
        }, this.refreshIntervalMs);
    }

    private applyOverview(
        overview: OperationalOverview,
        generation: number,
        version: number,
    ): void {
        if (!this.access.isCurrent(generation) || this.#version !== version) return;
        const state = this.access.getState();
        this.access.setState({
            ...state,
            overview,
            partialFailures: withoutFailure(state.partialFailures, "overview"),
        });
    }

    private applyFailure(
        error: unknown,
        generation: number,
        version: number,
    ): void {
        if (!this.access.isCurrent(generation) || this.#version !== version) return;
        const state = this.access.getState();
        this.access.setState({
            ...state,
            partialFailures: {
                ...state.partialFailures,
                overview: errorMessage(error),
            },
        });
    }
}

function withoutFailure(
    failures: Record<string, string>,
    key: string,
): Record<string, string> {
    const { [key]: _removed, ...remaining } = failures;
    return remaining;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
