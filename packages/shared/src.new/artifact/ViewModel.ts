// Stateful artifact projection. It owns its update policy: a single dedicated
// artifact event subscription reconnects with backoff and recovers gaps by
// re-reading the authoritative snapshot, and events are coalesced into a
// snapshot re-read. The snapshot carries the global event cursor, so resume
// never misses an event. No upper layer needs to call refresh() after an event.
// The connect/retry engine itself is the generic transport/stream subscription.

import { readArtifactStreamGap, type ArtifactStreamGap } from "./Contract.js";
import {
    EventSubscription,
    type SubscriptionStatus,
} from "../transport/stream/Subscription.js";
import type {
    ArtifactEvent,
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput,
} from "./Model.js";
import type { ArtifactTransport } from "./Transport.js";

export type ArtifactSubscriptionStatus = SubscriptionStatus;

export interface ArtifactViewModelState {
    failure?: Error;
    /** Global artifact event cursor captured with the last authoritative read. */
    lastSeq: number;
    shares: ArtifactShareResult[];
    status: ArtifactSubscriptionStatus;
    transfers: ArtifactTransferRecord[];
}

export interface ArtifactViewModelOptions {
    refreshDelayMs?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
}

export class ArtifactViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #transport: ArtifactTransport;
    readonly #refreshDelayMs: number;
    readonly #retryBaseMs: number;
    readonly #retryMaxMs: number;
    #active = false;
    #generation = 0;
    #published: ArtifactViewModelState = emptyState();
    #refreshTimer?: ReturnType<typeof setTimeout>;
    #state: ArtifactViewModelState = emptyState();
    #subscription?: EventSubscription<ArtifactEvent>;

    constructor(
        transport: ArtifactTransport,
        options: ArtifactViewModelOptions = {},
    ) {
        this.#transport = transport;
        this.#refreshDelayMs = options.refreshDelayMs ?? 100;
        this.#retryBaseMs = options.retryBaseMs ?? 500;
        this.#retryMaxMs = options.retryMaxMs ?? 15_000;
    }

    get state(): Readonly<ArtifactViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Reads the authoritative lists and opens the artifact subscription. */
    async load(): Promise<void> {
        if (this.#active) {
            await this.refresh();
            return;
        }
        this.#active = true;
        await this.refresh();
        if (!this.#active) return;
        this.#openSubscription();
    }

    async refresh(): Promise<void> {
        const generation = this.#generation;
        try {
            await this.#reload();
        } catch (error) {
            if (generation !== this.#generation) return;
            this.#state = { ...this.#state, failure: toError(error) };
            this.#emit();
        }
    }

    async revokeShare(shareId: string): Promise<void> {
        await this.#transport.revokeShare(shareId);
        await this.refresh();
    }

    async cancelTransfer(transferId: string): Promise<void> {
        await this.#transport.cancelTransfer(transferId);
        await this.refresh();
    }

    async createShare(
        defaultInstance: string,
        input: ArtifactShareInput,
    ): Promise<ArtifactShareResult> {
        const share = await this.#transport.createShare(defaultInstance, input);
        await this.refresh();
        return share;
    }

    async startTransfer(
        defaultInstance: string,
        input: ArtifactTransferStartInput,
    ): Promise<ArtifactTransferResult> {
        const result = await this.#transport.startTransfer(
            defaultInstance,
            input,
        );
        await this.refresh();
        return result;
    }

    close(): void {
        this.#active = false;
        this.#generation += 1;
        if (this.#refreshTimer !== undefined) {
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = undefined;
        }
        this.#subscription?.stop();
        this.#subscription = undefined;
        this.#listeners.clear();
        this.#state = emptyState();
        this.#published = this.#state;
    }

    #openSubscription(): void {
        const generation = this.#generation;
        this.#subscription = new EventSubscription<ArtifactEvent>(
            this.#state.lastSeq + 1,
            {
                eventSeq: (event) => event.seq,
                onEvent: () => this.#scheduleRefresh(generation),
                onGap: (gap) => this.#recover(gap, generation),
                onStatusChange: (status) => this.#setStatus(status),
                open: (fromSeq) => this.#transport.subscribe(fromSeq),
                readGapError: readArtifactStreamGap,
                retryBaseMs: this.#retryBaseMs,
                retryMaxMs: this.#retryMaxMs,
            },
        );
        this.#subscription.start();
    }

    async #reload(): Promise<void> {
        const generation = this.#generation;
        const snapshot = await this.#transport.snapshot();
        if (generation !== this.#generation) return;
        this.#state = {
            failure: undefined,
            lastSeq: snapshot.lastSeq,
            shares: [...snapshot.shares].sort(
                (left, right) => right.expiresAtMs - left.expiresAtMs,
            ),
            status: this.#state.status,
            transfers: [...snapshot.transfers].sort((left, right) =>
                right.createdAt.localeCompare(left.createdAt),
            ),
        };
        this.#emit();
    }

    async #recover(
        _gap: ArtifactStreamGap,
        generation: number,
    ): Promise<number | undefined> {
        try {
            await this.#reload();
            if (!this.#active || generation !== this.#generation)
                return undefined;
            return this.#state.lastSeq + 1;
        } catch {
            return undefined;
        }
    }

    #scheduleRefresh(generation: number): void {
        if (this.#refreshTimer !== undefined) return;
        this.#refreshTimer = setTimeout(() => {
            this.#refreshTimer = undefined;
            if (!this.#active || generation !== this.#generation) return;
            void this.refresh();
        }, this.#refreshDelayMs);
    }

    #setStatus(status: ArtifactSubscriptionStatus): void {
        if (this.#state.status === status) return;
        this.#state = { ...this.#state, status };
        this.#emit();
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = { ...this.#state };
        for (const listener of this.#listeners) listener();
    }
}

function emptyState(): ArtifactViewModelState {
    return { lastSeq: 0, shares: [], status: "stopped", transfers: [] };
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
