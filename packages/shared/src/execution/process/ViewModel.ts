// Stateful process projection. Owns the authoritative snapshot, the log view,
// and a single filtered event subscription that reconnects and recovers gaps
// by re-reading the snapshot (the cursor is snapshot.lastSeq + 1).

import {
    InstanceEventSubscription,
    type InstanceEventSubscriptionStatus,
} from "../../client/Stream.js";
import type {
    InstanceLogEntry,
    InstanceLogQuery,
    ProcessEvent,
} from "./Event.js";
import type { InstanceSnapshot } from "./Model.js";
import type { ProcessStartOptions, ProcessTransport } from "./Transport.js";

export interface ProcessViewModelState {
    connection: InstanceEventSubscriptionStatus;
    failure?: Error;
    lastSeq: number;
    logs: InstanceLogEntry[];
    logsLoaded: boolean;
    snapshot?: InstanceSnapshot;
}

export class ProcessViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #transport: ProcessTransport;
    #generation = 0;
    #readVersion = 0;
    #logVersion = 0;
    #subscribeRequested = false;
    #published: ProcessViewModelState = emptyState();
    #logRefreshTimer?: ReturnType<typeof setTimeout>;
    #logsRefreshing = false;
    #logsDirtyGeneration?: number;
    #refreshTimer?: ReturnType<typeof setTimeout>;
    #state: ProcessViewModelState = emptyState();
    #subscription?: InstanceEventSubscription<ProcessEvent>;

    constructor(transport: ProcessTransport) {
        this.#transport = transport;
    }

    get state(): Readonly<ProcessViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async load(signal?: AbortSignal): Promise<void> {
        const generation = ++this.#generation;
        this.#subscribeRequested = true;
        const version = ++this.#readVersion;
        const envelope = await this.#transport.refresh(signal);
        if (signal?.aborted || generation !== this.#generation || version !== this.#readVersion) return;
        this.#applySnapshot(envelope.snapshot, envelope.lastSeq);
        this.#ensureSubscription(envelope.lastSeq + 1);
    }

    async refresh(): Promise<void> {
        const generation = this.#generation;
        const version = ++this.#readVersion;
        const envelope = await this.#transport.refresh();
        if (generation !== this.#generation || version !== this.#readVersion) return;
        this.#applySnapshot(envelope.snapshot, envelope.lastSeq);
        if (this.#subscribeRequested) this.#ensureSubscription(envelope.lastSeq + 1);
    }

    async start(options: ProcessStartOptions = {}): Promise<InstanceSnapshot> {
        const generation = ++this.#generation;
        const version = ++this.#readVersion;
        const handle = await this.#transport.start(options);
        const snapshot = await handle.snapshot;
        if (generation !== this.#generation || version !== this.#readVersion) return snapshot;
        this.#applySnapshot(snapshot, snapshot.lastSeq);
        void this.refresh().catch(() => undefined);
        return snapshot;
    }

    async stop(signal?: AbortSignal): Promise<InstanceSnapshot> {
        const generation = ++this.#generation;
        const version = ++this.#readVersion;
        const snapshot = await this.#transport.stop(signal);
        if (generation !== this.#generation || version !== this.#readVersion) return snapshot;
        this.#applySnapshot(snapshot, snapshot.lastSeq);
        void this.refresh().catch(() => undefined);
        return snapshot;
    }

    async readLogs(query?: InstanceLogQuery, signal?: AbortSignal): Promise<InstanceLogEntry[]> {
        const generation = this.#generation;
        const version = ++this.#logVersion;
        const logs = await this.#transport.readLogs(query, signal);
        if (signal?.aborted || generation !== this.#generation || version !== this.#logVersion) return logs;
        this.#state = { ...this.#state, logs, logsLoaded: true };
        this.#emit();
        return logs;
    }

    close(): void {
        this.#generation += 1;
        this.#subscribeRequested = false;
        ++this.#readVersion;
        ++this.#logVersion;
        if (this.#refreshTimer !== undefined) {
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = undefined;
        }
        if (this.#logRefreshTimer !== undefined) {
            clearTimeout(this.#logRefreshTimer);
            this.#logRefreshTimer = undefined;
        }
        this.#logsDirtyGeneration = undefined;
        this.#subscription?.stop();
        this.#subscription = undefined;
        this.#listeners.clear();
        this.#state = emptyState();
        this.#published = this.#state;
    }

    #ensureSubscription(fromSeq: number): void {
        if (this.#subscription !== undefined) return;
        const subscription: InstanceEventSubscription<ProcessEvent> = new InstanceEventSubscription<ProcessEvent>(
            fromSeq,
            {
                onEvent: (event) => {
                    if (this.#subscription === subscription) this.#onEvent(event);
                },
                onGap: () => this.#subscription === subscription
                    ? this.#recover(subscription)
                    : undefined,
                onStatusChange: (status) => {
                    if (this.#subscription !== subscription) return;
                    this.#state = { ...this.#state, connection: status };
                    this.#emit();
                },
                open: (cursor) => this.#transport.subscribe(cursor),
            },
        );
        this.#subscription = subscription;
        subscription.start();
    }

    #onEvent(event: ProcessEvent): void {
        if (event.type === "log.appended" && this.#state.logsLoaded) {
            this.#scheduleLogRefresh();
            return;
        }
        if (
            event.type.startsWith("instance.") ||
            event.type.startsWith("worker.") ||
            event.type.startsWith("reverse.")
        )
            this.#scheduleRefresh();
    }

    #scheduleLogRefresh(): void {
        this.#logsDirtyGeneration = this.#generation;
        if (this.#logRefreshTimer !== undefined || this.#logsRefreshing) return;
        this.#logRefreshTimer = setTimeout(() => {
            this.#logRefreshTimer = undefined;
            const generation = this.#logsDirtyGeneration;
            this.#logsDirtyGeneration = undefined;
            if (generation !== this.#generation) return;
            this.#logsRefreshing = true;
            void this.readLogs().catch(() => undefined).finally(() => {
                this.#logsRefreshing = false;
                if (this.#logsDirtyGeneration === this.#generation) this.#scheduleLogRefresh();
            });
        }, 100);
    }

    #scheduleRefresh(): void {
        if (this.#refreshTimer !== undefined) return;
        this.#refreshTimer = setTimeout(() => {
            this.#refreshTimer = undefined;
            void this.refresh().catch(() => undefined);
        }, 100);
    }

    async #recover(subscription: InstanceEventSubscription<ProcessEvent>): Promise<number | undefined> {
        const generation = this.#generation;
        const version = ++this.#readVersion;
        ++this.#logVersion;
        try {
            const envelope = await this.#transport.refresh();
            if (generation !== this.#generation || version !== this.#readVersion ||
                this.#subscription !== subscription) return undefined;
            if (this.#state.logsLoaded) {
                // Invalidate any event read and absorb its pending timer into recovery.
                if (this.#logRefreshTimer !== undefined) clearTimeout(this.#logRefreshTimer);
                this.#logRefreshTimer = undefined;
                this.#logsDirtyGeneration = undefined;
                const reading = this.readLogs();
                const logVersion = this.#logVersion;
                await reading;
                if (logVersion !== this.#logVersion || generation !== this.#generation || version !== this.#readVersion ||
                    this.#subscription !== subscription) return undefined;
            }
            this.#applySnapshot(envelope.snapshot, envelope.lastSeq);
            return envelope.lastSeq + 1;
        } catch {
            return undefined;
        }
    }

    #applySnapshot(snapshot: InstanceSnapshot, sequence: number): void {
        this.#state = {
            ...this.#state,
            failure: undefined,
            lastSeq: Math.max(sequence, snapshot.lastSeq),
            snapshot,
        };
        this.#emit();
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = { ...this.#state };
        for (const listener of this.#listeners) listener();
    }
}

function emptyState(): ProcessViewModelState {
    return {
        connection: "stopped",
        lastSeq: 0,
        logs: [],
        logsLoaded: false,
    };
}
