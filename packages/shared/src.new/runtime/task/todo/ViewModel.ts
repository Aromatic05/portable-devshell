// Stateful todo projection. The read result is authoritative; the subscribed
// todo event stream only signals that the projection is stale, so events are
// coalesced into a re-read. Gap recovery re-reads and resumes from lastSeq + 1.

import type { InstanceEvent } from "../../activity/Model.js";
import {
    InstanceEventSubscription,
    type InstanceEventSubscriptionStatus,
} from "../../activity/Subscription.js";
import type { TodoReadInput, TodoReadResult } from "./Model.js";
import type { TodoTransport } from "./Transport.js";

export interface TodoViewModelState {
    failure?: Error;
    lastSeq: number;
    status: InstanceEventSubscriptionStatus;
    todo?: TodoReadResult;
}

export class TodoViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #transport: TodoTransport;
    #generation = 0;
    #input?: TodoReadInput;
    #instance?: string;
    #published: TodoViewModelState = emptyState();
    #refreshTimer?: ReturnType<typeof setTimeout>;
    #state: TodoViewModelState = emptyState();
    #subscription?: InstanceEventSubscription;

    constructor(transport: TodoTransport) {
        this.#transport = transport;
    }

    get state(): Readonly<TodoViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async load(instance: string, input?: TodoReadInput): Promise<void> {
        this.#instance = instance;
        this.#input = input;
        const generation = ++this.#generation;
        const envelope = await this.#transport.get(instance, input);
        if (generation !== this.#generation) return;
        this.#apply(envelope.todo, envelope.lastSeq);
        this.#ensureSubscription(envelope.lastSeq + 1);
    }

    async refresh(): Promise<void> {
        if (this.#instance === undefined) return;
        const instance = this.#instance;
        const generation = this.#generation;
        const envelope = await this.#transport.get(instance, this.#input);
        if (generation !== this.#generation) return;
        this.#apply(envelope.todo, envelope.lastSeq);
    }

    async delete(taskId: string): Promise<void> {
        const instance = this.#requireInstance();
        await this.#transport.delete(instance, taskId);
        await this.refresh();
    }

    close(): void {
        this.#generation += 1;
        this.#instance = undefined;
        this.#input = undefined;
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
            onEvent: (_event: InstanceEvent) => this.#scheduleRefresh(),
            onGap: () => this.#recover(),
            onStatusChange: (status) => {
                this.#state = { ...this.#state, status };
                this.#emit();
            },
            open: (cursor) => this.#transport.subscribe(instance, cursor),
        });
        this.#subscription.start();
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
            const envelope = await this.#transport.get(instance, this.#input);
            this.#apply(envelope.todo, envelope.lastSeq);
            return envelope.lastSeq + 1;
        } catch {
            return undefined;
        }
    }

    #apply(todo: TodoReadResult, sequence: number): void {
        this.#state = {
            ...this.#state,
            failure: undefined,
            lastSeq: sequence,
            todo,
        };
        this.#emit();
    }

    #requireInstance(): string {
        if (this.#instance === undefined)
            throw new Error("Todo view model is not loaded.");
        return this.#instance;
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = { ...this.#state };
        for (const listener of this.#listeners) listener();
    }
}

function emptyState(): TodoViewModelState {
    return { lastSeq: 0, status: "stopped" };
}
