import {
    InstanceEventSubscription,
    type InstanceEventSubscriptionStatus,
} from "../../client/Stream.js";
import {
    type GoalSnapshot,
    isGoalEvent,
    type TaskEvent,
} from "./Model.js";
import type { TaskTransport } from "./Transport.js";

const DEFAULT_REFRESH_DELAY_MS = 100;
interface GoalInstanceState {
    failure?: Error;
    goals: GoalSnapshot[];
    lastSeq: number;
    status: InstanceEventSubscriptionStatus;
}
export interface GoalViewModelState {
    instances: Record<string, GoalInstanceState>;
}
interface GoalViewModelOptions {
    onEvent?(event: TaskEvent): void;
    refreshDelayMs?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
    transport(instance: string): TaskTransport;
}
export class GoalViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #onEvent?: (event: TaskEvent) => void;
    readonly #refreshDelayMs: number;
    readonly #refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #retryBaseMs: number;
    readonly #retryMaxMs: number;
    readonly #subscriptions = new Map<
        string,
        InstanceEventSubscription<TaskEvent>
    >();
    readonly #transport: (instance: string) => TaskTransport;
    readonly #versions = new Map<string, number>();
    #epoch = 0;
    #published: GoalViewModelState = emptyState();
    #state: GoalViewModelState = emptyState();

    constructor(options: GoalViewModelOptions) {
        this.#onEvent = options.onEvent;
        this.#refreshDelayMs =
            options.refreshDelayMs ?? DEFAULT_REFRESH_DELAY_MS;
        this.#retryBaseMs = options.retryBaseMs ?? 500;
        this.#retryMaxMs = options.retryMaxMs ?? 15_000;
        this.#transport = options.transport;
    }

    get state(): Readonly<GoalViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /**
     * Materializes one instance: reads the authoritative snapshot, then lazily
     * starts the instance's event subscription from lastSeq + 1. Calling it
     * again for the same instance re-reads without restarting the subscription.
     */
    async load(instance: string): Promise<void> {
        const epoch = this.#epoch;
        const lastSeq = await this.#refreshInstance(instance, epoch);
        if (!this.#current(epoch) || lastSeq === undefined) return;
        this.#ensureSubscription(instance, lastSeq + 1);
    }

    /** Re-reads the authoritative goal snapshot for one instance. */
    async refresh(instance: string): Promise<void> {
        await this.#refreshInstance(instance, this.#epoch);
    }

    /** Stops one instance's subscription, or every subscription when omitted. */
    stop(instance?: string): void {
        if (instance === undefined) {
            for (const timer of this.#refreshTimers.values())
                clearTimeout(timer);
            this.#refreshTimers.clear();
            this.#closeSubscriptions();
            return;
        }
        const timer = this.#refreshTimers.get(instance);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.#refreshTimers.delete(instance);
        }
        this.#subscriptions.get(instance)?.stop();
        this.#subscriptions.delete(instance);
    }

    /** Stops and forgets one materialized instance. */
    release(instance: string): void {
        this.stop(instance);
        this.#versions.delete(instanceKey(instance));
        if (!(instance in this.#state.instances)) return;
        const instances = { ...this.#state.instances };
        delete instances[instance];
        this.#state = { ...this.#state, instances };
        this.#emit();
    }

    close(): void {
        this.#epoch += 1;
        for (const timer of this.#refreshTimers.values()) clearTimeout(timer);
        this.#refreshTimers.clear();
        this.#versions.clear();
        this.#closeSubscriptions();
        this.#listeners.clear();
        this.#state = emptyState();
        this.#published = this.#state;
    }

    /** Returns the authoritative read-time sequence when the read applied. */
    async #refreshInstance(
        instance: string,
        epoch: number,
    ): Promise<number | undefined> {
        const key = instanceKey(instance);
        const version = this.#nextVersion(key);
        try {
            const envelope = await this.#transport(instance).getGoals();
            if (!this.#valid(key, version, epoch)) return undefined;
            this.#updateInstance(instance, (state) => ({
                ...state,
                failure: undefined,
                goals: envelope.goals,
                lastSeq: Math.max(state.lastSeq, envelope.lastSeq),
            }));
            this.#emit();
            return envelope.lastSeq;
        } catch (error) {
            if (!this.#valid(key, version, epoch)) return undefined;
            this.#updateInstance(instance, (state) => ({
                ...state,
                failure: toError(error),
            }));
            this.#emit();
            return undefined;
        }
    }

    #ensureSubscription(instance: string, fromSeq: number): void {
        if (this.#subscriptions.has(instance)) return;
        const epoch = this.#epoch;
        const subscription = new InstanceEventSubscription<TaskEvent>(fromSeq, {
            onEvent: (event) => {
                if (this.#current(epoch)) this.#applyEvent(event);
            },
            onGap: () => this.#recover(instance, epoch),
            onStatusChange: (status) => {
                if (!this.#current(epoch)) return;
                this.#updateInstance(instance, (state) => ({
                    ...state,
                    status,
                }));
                this.#emit();
            },
            open: (cursor) => this.#transport(instance).subscribe(cursor),
            retryBaseMs: this.#retryBaseMs,
            retryMaxMs: this.#retryMaxMs,
        });
        this.#subscriptions.set(instance, subscription);
        subscription.start();
    }

    #applyEvent(event: TaskEvent): void {
        if (!isGoalEvent(event.type)) return;
        const instance = event.instanceName;
        this.#updateInstance(instance, (state) => ({
            ...state,
            lastSeq: Math.max(state.lastSeq, event.seq),
        }));
        this.#scheduleRefresh(instance, this.#epoch);
        this.#onEvent?.(event);
        this.#emit();
    }

    async #recover(
        instance: string,
        epoch: number,
    ): Promise<number | undefined> {
        const lastSeq = await this.#refreshInstance(instance, epoch);
        if (!this.#current(epoch) || lastSeq === undefined) return undefined;
        return lastSeq + 1;
    }

    #scheduleRefresh(instance: string, epoch: number): void {
        if (this.#refreshTimers.has(instance)) return;
        const timer = setTimeout(() => {
            this.#refreshTimers.delete(instance);
            if (this.#current(epoch))
                void this.#refreshInstance(instance, epoch);
        }, this.#refreshDelayMs);
        this.#refreshTimers.set(instance, timer);
    }

    #closeSubscriptions(): void {
        for (const subscription of this.#subscriptions.values())
            subscription.stop();
        this.#subscriptions.clear();
    }

    #updateInstance(
        instance: string,
        update: (state: GoalInstanceState) => GoalInstanceState,
    ): void {
        this.#state.instances = {
            ...this.#state.instances,
            [instance]: update(
                this.#state.instances[instance] ?? emptyInstanceState(),
            ),
        };
    }

    #nextVersion(key: string): number {
        const version = (this.#versions.get(key) ?? 0) + 1;
        this.#versions.set(key, version);
        return version;
    }

    #valid(key: string, version: number, epoch: number): boolean {
        return this.#current(epoch) && this.#versions.get(key) === version;
    }

    #current(epoch: number): boolean {
        return this.#epoch === epoch;
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = {
            ...this.#published,
            instances: { ...this.#published.instances },
        };
        for (const listener of this.#listeners) listener();
    }
}
function emptyState(): GoalViewModelState {
    return { instances: {} };
}
function emptyInstanceState(): GoalInstanceState {
    return { goals: [], lastSeq: 0, status: "stopped" };
}
function instanceKey(instance: string): string {
    return `goal:${instance}`;
}
function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
