// Stateful Context record projection. Owns the authoritative Context list and
// the Context lifecycle actions (disable/renew); it has no instance event
// subscription because Context records are control-plane state.

import type { McpContextRecord } from "./Model.js";
import type { ContextTransport } from "./Transport.js";

export interface ContextViewModelState {
    contexts: McpContextRecord[];
    failure?: Error;
}

export class ContextViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #transport: ContextTransport;
    #generation = 0;
    #published: ContextViewModelState = emptyContextViewModelState();
    #state: ContextViewModelState = emptyContextViewModelState();

    constructor(transport: ContextTransport) {
        this.#transport = transport;
    }

    get state(): Readonly<ContextViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async load(signal?: AbortSignal): Promise<void> {
        await this.refresh(signal);
    }

    async refresh(signal?: AbortSignal): Promise<void> {
        const generation = this.#generation;
        try {
            const contexts = await this.#transport.list(signal);
            if (generation !== this.#generation) return;
            this.#state = {
                contexts: [...contexts].sort((left, right) =>
                    left.createdAt.localeCompare(right.createdAt),
                ),
                failure: undefined,
            };
        } catch (error) {
            if (generation !== this.#generation) return;
            this.#state = { ...this.#state, failure: toError(error) };
        }
        this.#emit();
    }

    async disable(
        ctxId: string,
        signal?: AbortSignal,
    ): Promise<McpContextRecord> {
        const record = await this.#transport.disable(ctxId, signal);
        await this.refresh(signal);
        return record;
    }

    async renew(ctxId: string, signal?: AbortSignal): Promise<McpContextRecord> {
        const record = await this.#transport.renew(ctxId, signal);
        await this.refresh(signal);
        return record;
    }

    close(): void {
        this.#generation += 1;
        this.#listeners.clear();
        this.#state = emptyContextViewModelState();
        this.#published = this.#state;
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = { ...this.#published };
        for (const listener of this.#listeners) listener();
    }
}

function emptyContextViewModelState(): ContextViewModelState {
    return { contexts: [] };
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}