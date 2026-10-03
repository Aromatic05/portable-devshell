// Stateful process projection. Owns the authoritative snapshot, the log view,
// and a single filtered event subscription that reconnects and recovers gaps
// by re-reading the snapshot (the cursor is snapshot.lastSeq + 1).

import type { InstanceEvent } from "./Event.js";
import type { InstanceLogEntry, InstanceLogQuery } from "./Event.js";
import {
    InstanceEventSubscription,
    type InstanceEventSubscriptionStatus,
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
    #instance?: string;
    #published: ProcessViewModelState = emptyState();
    #refreshTimer?: ReturnType<typeof setTimeout>;
    #state: ProcessViewModelState = emptyState();
    #subscription?: InstanceEventSubscription;

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

    async load(instance: string): Promise<void> {
        this.#instance = instance;
        const generation = ++this.#generation;
        const envelope = await this.#transport.refresh(instance);
        if (generation !== this.#generation) return;
        this.#applySnapshot(envelope.snapshot, envelope.lastSeq);
        this.#ensureSubscription(envelope.lastSeq + 1);
    }

    async refresh(): Promise<void> {
        const instance = this.#requireInstance();
        const generation = this.#generation;
        const envelope = await this.#transport.refresh(instance);
        if (generation !== this.#generation) return;
        this.#applySnapshot(envelope.snapshot, envelope.lastSeq);
    }

    async start(options: ProcessStartOptions = {}): Promise<InstanceSnapshot> {
        const instance = this.#requireInstance();
        const generation = ++this.#generation;
        const handle = await this.#transport.start(instance, options);
        const snapshot = await handle.snapshot;
        if (generation !== this.#generation) return snapshot;
        this.#applySnapshot(snapshot, snapshot.lastSeq);
        void this.refresh().catch(() => undefined);
        return snapshot;
    }

    async stop(): Promise<InstanceSnapshot> {
        const instance = this.#requireInstance();
        const generation = ++this.#generation;
        const snapshot = await this.#transport.stop(instance);
        if (generation !== this.#generation) return snapshot;
        this.#applySnapshot(snapshot, snapshot.lastSeq);
        void this.refresh().catch(() => undefined);
        return snapshot;
    }

    async readLogs(query?: InstanceLogQuery): Promise<InstanceLogEntry[]> {
        const instance = this.#requireInstance();
        const generation = this.#generation;
        const logs = await this.#transport.readLogs(instance, query);
        if (generation !== this.#generation) return logs;
        this.#state = { ...this.#state, logs, logsLoaded: true };
        this.#emit();
        return logs;
    }

    close(): void {
        this.#generation += 1;
        this.#instance = undefined;
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

    #ensureSubscription(fromSeq: number): void {
        if (this.#subscription !== undefined) return;
        const instance = this.#requireInstance();
        this.#subscription = new InstanceEventSubscription(fromSeq, {
            onEvent: (event) => this.#onEvent(event),
            onGap: () => this.#recover(),
            onStatusChange: (status) => {
                this.#state = { ...this.#state, connection: status };
                this.#emit();
            },
            open: (cursor) => this.#transport.subscribe(instance, cursor),
        });
        this.#subscription.start();
    }

    #onEvent(event: InstanceEvent): void {
        if (event.type === "log.appended" && this.#state.logsLoaded) {
            this.#scheduleRefresh();
            return;
        }
        if (
            event.type.startsWith("instance.") ||
            event.type.startsWith("worker.") ||
            event.type.startsWith("reverse.")
        )
            this.#scheduleRefresh();
    }

    #scheduleRefresh(): void {
        if (this.#refreshTimer !== undefined) return;
        this.#refreshTimer = setTimeout(() => {
            this.#refreshTimer = undefined;
            void this.refresh().catch(() => undefined);
        }, 100);
    }

    async #recover(): Promise<number | undefined> {
        try {
            const instance = this.#requireInstance();
            const envelope = await this.#transport.refresh(instance);
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

    #requireInstance(): string {
        if (this.#instance === undefined)
            throw new Error("Process view model is not loaded.");
        return this.#instance;
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
