import { EventSubscription, readStreamGap, type SubscriptionStatus } from "../../client/Stream.js";
import type { ContextChangeEvent, ContextSnapshot } from "./Revision.js";
import type { McpContextRecord } from "./Model.js";
import type { ContextTransport } from "./Transport.js";

interface ContextViewModelState {
    contexts: McpContextRecord[];
    revision: number;
    connection: SubscriptionStatus;
    failure?: Error;
}

export class ContextViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #transport: ContextTransport;
    #generation = 0;
    #readGeneration = 0;
    #subscription?: EventSubscription<ContextChangeEvent>;
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
        const generation = this.#generation;
        const snapshot = await this.#read(signal);
        if (generation === this.#generation && snapshot !== undefined)
            this.#startSubscription();
    }

    async refresh(signal?: AbortSignal): Promise<void> {
        await this.#read(signal);
    }

    async #read(signal?: AbortSignal): Promise<ContextSnapshot | undefined> {
        const generation = this.#generation;
        const readGeneration = ++this.#readGeneration;
        try {
            const snapshot = await this.#transport.snapshot(signal);
            const contexts = snapshot.contexts;
            if (generation !== this.#generation || readGeneration !== this.#readGeneration) return undefined;
            this.#state = {
                ...this.#state,
                revision: snapshot.revision,
                contexts: [...contexts].sort((left, right) =>
                    left.createdAt.localeCompare(right.createdAt),
                ),
                failure: undefined,
            };
            this.#emit();
            return snapshot;
        } catch (error) {
            if (generation !== this.#generation || readGeneration !== this.#readGeneration) return undefined;
            this.#state = { ...this.#state, failure: toError(error) };
        }
        this.#emit();
        return undefined;
    }

    async disable(
        ctxId: string,
        signal?: AbortSignal,
    ): Promise<McpContextRecord> {
        const record = await this.#transport.disable(ctxId, signal);
        await this.refresh(signal);
        return record;
    }

    async renew(
        ctxId: string,
        signal?: AbortSignal,
    ): Promise<McpContextRecord> {
        const record = await this.#transport.renew(ctxId, signal);
        await this.refresh(signal);
        return record;
    }

    close(): void {
        this.#generation += 1;
        this.#subscription?.stop();
        this.#subscription = undefined;
        this.#listeners.clear();
        this.#state = emptyContextViewModelState();
        this.#published = this.#state;
    }

    #startSubscription(): void {
        if (this.#subscription !== undefined || this.#state.failure !== undefined) return;
        const generation = this.#generation;
        this.#subscription = new EventSubscription(this.#state.revision + 1, {
            eventSeq: event => event.revision,
            onEvent: event => {
                if (event.revision > this.#state.revision) void this.#read();
            },
            onGap: async () => {
                const snapshot = await this.#read();
                return generation !== this.#generation || snapshot === undefined ? undefined : snapshot.revision + 1;
            },
            onStatusChange: connection => {
                this.#state = { ...this.#state, connection };
                this.#emit();
            },
            open: fromRevision => this.#transport.subscribe(fromRevision),
            readGapError: readStreamGap,
        });
        this.#subscription.start();
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = { ...this.#published };
        for (const listener of this.#listeners) listener();
    }
}

function emptyContextViewModelState(): ContextViewModelState {
    return { contexts: [], revision: 0, connection: "stopped" };
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
