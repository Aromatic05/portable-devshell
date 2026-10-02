// Stateful Conversation projection. Owns Conversation entries, Conversation
// preferences, and per-instance subscriptions. `conversation.list` is the
// authoritative snapshot (entries plus the instance sequence at read time); the
// shared instance event stream only marks the projection stale, so events are
// coalesced into an authoritative re-read. Gap recovery re-reads and resumes
// from the snapshot's lastSeq + 1.

import type { InstanceEvent } from "../../runtime/activity/Model.js";
import {
    InstanceEventSubscription,
    type InstanceEventSubscriptionStatus,
} from "../../runtime/activity/Subscription.js";
import {
    createEmptyConversationPreferences,
    isConversationEvent,
    mergeConversationEntryList,
    type ConversationEntry,
    type ConversationPreferencesPatch,
    type ConversationPreferencesSnapshot,
} from "./Model.js";
import type { ConversationTransport } from "./Transport.js";

export interface ConversationInstanceState {
    entries: ConversationEntry[];
    lastSeq: number;
    status: InstanceEventSubscriptionStatus;
}

export interface ConversationViewModelState {
    failures: Record<string, Error>;
    instances: Record<string, ConversationInstanceState>;
    preferences: ConversationPreferencesSnapshot;
}

export interface ConversationViewModelOptions {
    transport: ConversationTransport;
    onEvent?(event: InstanceEvent): void;
}

const REFRESH_DELAY_MS = 100;
const CONVERSATION_LIST_LIMIT = 400;
const CONVERSATION_LIST_MAX_BYTES = 1024 * 1024;

export class ConversationViewModel {
    readonly #transport: ConversationTransport;
    readonly #listeners = new Set<() => void>();
    readonly #onEvent?: (event: InstanceEvent) => void;
    readonly #versions = new Map<string, number>();
    readonly #refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #subscriptions = new Map<string, InstanceEventSubscription>();
    #epoch = 0;
    #publishedState: ConversationViewModelState =
        createInitialConversationViewModelState();
    #state: ConversationViewModelState = createInitialConversationViewModelState();

    constructor(options: ConversationViewModelOptions) {
        this.#transport = options.transport;
        this.#onEvent = options.onEvent;
    }

    get state(): Readonly<ConversationViewModelState> {
        return this.#publishedState;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /**
     * Loads Conversation preferences and, when instances are provided, hydrates
     * and subscribes each instance. Instances added later use `ensureInstance`.
     */
    async load(instances: readonly string[] = []): Promise<void> {
        const epoch = this.#epoch;
        await Promise.all([
            this.refreshPreferences(),
            ...instances.map((instance) => this.refreshInstance(instance)),
        ]);
        if (!this.#current(epoch)) return;
        for (const instance of instances) {
            const state = this.#state.instances[instance];
            if (state !== undefined)
                this.#ensureSubscription(instance, state.lastSeq + 1);
        }
        this.#closeOrphanSubscriptions(new Set(instances));
    }

    async refreshPreferences(): Promise<void> {
        const epoch = this.#epoch;
        const version = this.#nextVersion("preferences");
        try {
            const preferences = await this.#transport.readPreferences();
            if (!this.#valid("preferences", version, epoch)) return;
            this.#state.preferences = preferences;
            this.#clearFailure("preferences");
            this.#emit();
        } catch (error) {
            if (!this.#valid("preferences", version, epoch)) return;
            this.#setFailure("preferences", error);
            this.#emit();
        }
    }

    /**
     * Reads the authoritative Conversation snapshot. Returns the read-time
     * instance sequence so the caller can resume from lastSeq + 1.
     */
    async refreshInstance(instance: string): Promise<number | undefined> {
        const key = this.#instanceVersionKey(instance);
        const epoch = this.#epoch;
        const version = this.#nextVersion(key);
        try {
            const result = await this.#transport.list(instance, {
                limit: CONVERSATION_LIST_LIMIT,
                maxBytes: CONVERSATION_LIST_MAX_BYTES,
            });
            if (!this.#valid(key, version, epoch)) return undefined;
            this.#updateInstance(instance, (state) => ({
                ...state,
                entries: mergeConversationEntryList(
                    state.entries,
                    result.entries,
                ),
                lastSeq: Math.max(state.lastSeq, result.lastSeq),
            }));
            this.#clearFailure(key);
            this.#emit();
            return result.lastSeq;
        } catch (error) {
            if (!this.#valid(key, version, epoch)) return undefined;
            this.#setFailure(key, error);
            this.#emit();
            return undefined;
        }
    }

    async updatePreferences(
        patch: ConversationPreferencesPatch,
    ): Promise<ConversationPreferencesSnapshot> {
        const preferences = await this.#transport.updatePreferences(patch);
        this.#state.preferences = preferences;
        this.#clearFailure("preferences");
        this.#emit();
        return preferences;
    }

    ensureInstance(instance: string, fromSeq?: number): void {
        const state = this.#state.instances[instance];
        if (state === undefined) return;
        this.#ensureSubscription(instance, fromSeq ?? state.lastSeq + 1);
    }

    reset(): void {
        this.#epoch += 1;
        for (const timer of this.#refreshTimers.values()) clearTimeout(timer);
        this.#refreshTimers.clear();
        this.#versions.clear();
        this.#closeSubscriptions();
        this.#state = createInitialConversationViewModelState();
        this.#emit();
    }

    close(): void {
        this.reset();
        this.#listeners.clear();
    }

    #ensureSubscription(instance: string, fromSeq: number): void {
        if (this.#subscriptions.has(instance)) return;
        const epoch = this.#epoch;
        const subscription = new InstanceEventSubscription(fromSeq, {
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
            open: (cursor) => this.#transport.subscribe(instance, cursor),
        });
        this.#subscriptions.set(instance, subscription);
        subscription.start();
    }

    #applyEvent(event: InstanceEvent): void {
        if (!isConversationEvent(event)) return;
        this.#updateInstance(event.instanceName, (state) => ({
            ...state,
            lastSeq: Math.max(state.lastSeq, event.seq),
        }));
        this.#scheduleRefresh(event.instanceName, this.#epoch);
        this.#onEvent?.(event);
        this.#emit();
    }

    async #recover(
        instance: string,
        epoch: number,
    ): Promise<number | undefined> {
        const lastSeq = await this.refreshInstance(instance);
        if (!this.#current(epoch) || lastSeq === undefined) return undefined;
        return lastSeq + 1;
    }

    #scheduleRefresh(instance: string, epoch: number): void {
        if (this.#refreshTimers.has(instance)) return;
        const timer = setTimeout(() => {
            this.#refreshTimers.delete(instance);
            if (this.#current(epoch)) void this.refreshInstance(instance);
        }, REFRESH_DELAY_MS);
        this.#refreshTimers.set(instance, timer);
    }

    #closeOrphanSubscriptions(names: ReadonlySet<string>): void {
        for (const [instance, subscription] of [...this.#subscriptions]) {
            if (names.has(instance)) continue;
            subscription.stop();
            this.#subscriptions.delete(instance);
        }
    }

    #closeSubscriptions(): void {
        for (const subscription of this.#subscriptions.values())
            subscription.stop();
        this.#subscriptions.clear();
    }

    #updateInstance(
        instance: string,
        update: (state: ConversationInstanceState) => ConversationInstanceState,
    ): void {
        this.#state.instances = {
            ...this.#state.instances,
            [instance]: update(
                this.#state.instances[instance] ??
                    createInitialConversationInstanceState(),
            ),
        };
    }

    #instanceVersionKey(instance: string): string {
        return `conversation:${instance}`;
    }

    #setFailure(key: string, error: unknown): void {
        this.#state.failures = {
            ...this.#state.failures,
            [key]: error instanceof Error ? error : new Error(String(error)),
        };
    }

    #clearFailure(key: string): void {
        if (this.#state.failures[key] === undefined) return;
        const failures = { ...this.#state.failures };
        delete failures[key];
        this.#state.failures = failures;
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
        this.#publishedState = this.#state;
        this.#state = {
            ...this.#publishedState,
            failures: { ...this.#publishedState.failures },
            instances: { ...this.#publishedState.instances },
        };
        for (const listener of this.#listeners) listener();
    }
}

export function createInitialConversationViewModelState(): ConversationViewModelState {
    return {
        failures: {},
        instances: {},
        preferences: createEmptyConversationPreferences(),
    };
}

function createInitialConversationInstanceState(): ConversationInstanceState {
    return {
        entries: [],
        lastSeq: 0,
        status: "stopped",
    };
}