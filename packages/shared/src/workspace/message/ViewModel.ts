import {
    InstanceEventSubscription,
    type InstanceEventSubscriptionStatus,
} from "../../client/Stream.js";
import {
    type ContextMessageListInput,
    type ContextMessageRecord,
    type MessageEntry,
    type MessageEvent,
    isContextMessageEvent,
    isMessageHistoryEvent,
    mergeContextMessage,
    mergeContextMessageList,
    mergeMessageEntryList,
} from "./Model.js";
import type { MessagePreferenceTransport, MessageTransport } from "./Transport.js";
import { createEmptyMessagePreferences, type MessagePreferencesPatch, type MessagePreferencesSnapshot } from "./Preference.js";

interface MessageInstanceState {
    lastSeq: number;
    messages: ContextMessageRecord[];
    status: InstanceEventSubscriptionStatus;
}
export interface MessageViewModelState {
    failures: Record<string, Error>;
    instances: Record<string, MessageInstanceState>;
}
interface MessageViewModelOptions {
    onEvent?(event: MessageEvent): void;
    transport: MessageTransport;
}
const REFRESH_DELAY_MS = 100;
const MESSAGE_LIST_LIMIT = 400;
const MESSAGE_LIST_MAX_BYTES = 1024 * 1024;
export class MessageViewModel {
    readonly #transport: MessageTransport;
    readonly #listeners = new Set<() => void>();
    readonly #onEvent?: (event: MessageEvent) => void;
    readonly #versions = new Map<string, number>();
    readonly #refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #subscriptions = new Map<
        string,
        InstanceEventSubscription<MessageEvent>
    >();
    #epoch = 0;
    #publishedState: MessageViewModelState =
        createInitialMessageViewModelState();
    #state: MessageViewModelState = createInitialMessageViewModelState();

    constructor(options: MessageViewModelOptions) {
        this.#transport = options.transport;
        this.#onEvent = options.onEvent;
    }

    get state(): Readonly<MessageViewModelState> {
        return this.#publishedState;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /**
     * Hydrates and subscribes each instance. Instances added later use
     * `ensureInstance`.
     */
    async load(instances: readonly string[] = []): Promise<void> {
        const epoch = this.#epoch;
        await Promise.all(
            instances.map((instance) => this.refreshInstance(instance)),
        );
        if (!this.#current(epoch)) return;
        for (const instance of instances) {
            const state = this.#state.instances[instance];
            if (state !== undefined)
                this.#ensureSubscription(instance, state.lastSeq + 1);
        }
        this.#closeOrphanSubscriptions(new Set(instances));
    }

    /**
     * Reads the authoritative Context message snapshot. Returns the read-time
     * instance sequence so the caller can resume from lastSeq + 1.
     */
    async refreshInstance(instance: string): Promise<number | undefined> {
        const key = this.#instanceVersionKey(instance);
        const epoch = this.#epoch;
        const version = this.#nextVersion(key);
        try {
            const result = await this.#transport.listContextMessages(instance, {
                limit: MESSAGE_LIST_LIMIT,
                maxBytes: MESSAGE_LIST_MAX_BYTES,
            });
            if (!this.#valid(key, version, epoch)) return undefined;
            this.#updateInstance(instance, (state) => ({
                ...state,
                lastSeq: Math.max(state.lastSeq, result.lastSeq),
                messages: mergeContextMessageList(
                    state.messages,
                    result.messages,
                ),
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

    /** Reads a paginated Context message page and merges in-flight records. */
    async loadMessages(
        instance: string,
        options: ContextMessageListInput = {},
    ): Promise<void> {
        const key = this.#instanceVersionKey(instance);
        const epoch = this.#epoch;
        const version = this.#nextVersion(key);
        try {
            const result = await this.#transport.listContextMessages(
                instance,
                options,
            );
            if (!this.#valid(key, version, epoch)) return;
            this.#updateInstance(instance, (state) => {
                let messages = state.messages;
                for (const message of result.messages)
                    messages = mergeContextMessage(messages, message);
                return {
                    ...state,
                    lastSeq: Math.max(state.lastSeq, result.lastSeq),
                    messages,
                };
            });
            this.#clearFailure(key);
            this.#emit();
        } catch (error) {
            if (!this.#valid(key, version, epoch)) return;
            this.#setFailure(key, error);
            this.#emit();
        }
    }

    async queue(
        instance: string,
        ctxId: string,
        text: string,
    ): Promise<ContextMessageRecord> {
        const queued = await this.#transport.queueContextMessage(instance, {
            ctxId,
            text,
        });
        this.mergeMessage(instance, queued);
        return queued;
    }

    /** Folds an authoritative queued/read message into the projection. */
    mergeMessage(instance: string, message: ContextMessageRecord): void {
        this.#updateInstance(instance, (state) => ({
            ...state,
            messages: mergeContextMessage(state.messages, message),
        }));
        this.#clearFailure(this.#instanceVersionKey(instance));
        this.#emit();
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
        this.#state = createInitialMessageViewModelState();
        this.#emit();
    }

    close(): void {
        this.reset();
        this.#listeners.clear();
    }

    #ensureSubscription(instance: string, fromSeq: number): void {
        if (this.#subscriptions.has(instance)) return;
        const epoch = this.#epoch;
        const subscription = new InstanceEventSubscription<MessageEvent>(
            fromSeq,
            {
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
            },
        );
        this.#subscriptions.set(instance, subscription);
        subscription.start();
    }

    #applyEvent(event: MessageEvent): void {
        if (!isContextMessageEvent(event)) return;
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
        update: (state: MessageInstanceState) => MessageInstanceState,
    ): void {
        this.#state.instances = {
            ...this.#state.instances,
            [instance]: update(
                this.#state.instances[instance] ??
                    createInitialMessageInstanceState(),
            ),
        };
    }

    #instanceVersionKey(instance: string): string {
        return `message:${instance}`;
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
function createInitialMessageViewModelState(): MessageViewModelState {
    return {
        failures: {},
        instances: {},
    };
}
function createInitialMessageInstanceState(): MessageInstanceState {
    return {
        lastSeq: 0,
        messages: [],
        status: "stopped",
    };
}
interface MessageHistoryInstanceState {
    entries: MessageEntry[];
    lastSeq: number;
    status: InstanceEventSubscriptionStatus;
}
export interface MessageHistoryViewModelState {
    failures: Record<string, Error>;
    instances: Record<string, MessageHistoryInstanceState>;
}
interface MessageHistoryViewModelOptions {
    transport: MessageTransport;
    onEvent?(event: MessageEvent): void;
}
const MESSAGE_HISTORY_REFRESH_DELAY_MS = 100;
const MESSAGE_HISTORY_LIST_LIMIT = 400;
const MESSAGE_HISTORY_LIST_MAX_BYTES = 1024 * 1024;
export class MessageHistoryViewModel {
    readonly #transport: MessageTransport;
    readonly #listeners = new Set<() => void>();
    readonly #onEvent?: (event: MessageEvent) => void;
    readonly #versions = new Map<string, number>();
    readonly #refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #subscriptions = new Map<
        string,
        InstanceEventSubscription<MessageEvent>
    >();
    #epoch = 0;
    #publishedState: MessageHistoryViewModelState =
        createInitialMessageHistoryViewModelState();
    #state: MessageHistoryViewModelState =
        createInitialMessageHistoryViewModelState();

    constructor(options: MessageHistoryViewModelOptions) {
        this.#transport = options.transport;
        this.#onEvent = options.onEvent;
    }

    get state(): Readonly<MessageHistoryViewModelState> {
        return this.#publishedState;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Hydrates and subscribes each instance. */
    async load(instances: readonly string[] = []): Promise<void> {
        const epoch = this.#epoch;
        await Promise.all(
            instances.map((instance) => this.refreshInstance(instance)),
        );
        if (!this.#current(epoch)) return;
        for (const instance of instances) {
            const state = this.#state.instances[instance];
            if (state !== undefined)
                this.#ensureSubscription(instance, state.lastSeq + 1);
        }
        this.#closeOrphanSubscriptions(new Set(instances));
    }

    /**
     * Reads the authoritative Message snapshot. Returns the read-time
     * instance sequence so the caller can resume from lastSeq + 1.
     */
    async refreshInstance(instance: string): Promise<number | undefined> {
        const key = this.#instanceVersionKey(instance);
        const epoch = this.#epoch;
        const version = this.#nextVersion(key);
        try {
            const result = await this.#transport.listMessageEntries(
                instance,
                {
                    limit: MESSAGE_HISTORY_LIST_LIMIT,
                    maxBytes: MESSAGE_HISTORY_LIST_MAX_BYTES,
                },
            );
            if (!this.#valid(key, version, epoch)) return undefined;
            this.#updateInstance(instance, (state) => ({
                ...state,
                entries: mergeMessageEntryList(
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
        this.#state = createInitialMessageHistoryViewModelState();
        this.#emit();
    }

    close(): void {
        this.reset();
        this.#listeners.clear();
    }

    #ensureSubscription(instance: string, fromSeq: number): void {
        if (this.#subscriptions.has(instance)) return;
        const epoch = this.#epoch;
        const subscription = new InstanceEventSubscription<MessageEvent>(
            fromSeq,
            {
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
            },
        );
        this.#subscriptions.set(instance, subscription);
        subscription.start();
    }

    #applyEvent(event: MessageEvent): void {
        if (!isMessageHistoryEvent(event)) return;
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
        }, MESSAGE_HISTORY_REFRESH_DELAY_MS);
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
        update: (state: MessageHistoryInstanceState) => MessageHistoryInstanceState,
    ): void {
        this.#state.instances = {
            ...this.#state.instances,
            [instance]: update(
                this.#state.instances[instance] ??
                    createInitialMessageHistoryInstanceState(),
            ),
        };
    }

    #instanceVersionKey(instance: string): string {
        return `message-history:${instance}`;
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
function createInitialMessageHistoryViewModelState(): MessageHistoryViewModelState {
    return {
        failures: {},
        instances: {},
    };
}
function createInitialMessageHistoryInstanceState(): MessageHistoryInstanceState {
    return {
        entries: [],
        lastSeq: 0,
        status: "stopped",
    };
}

export interface MessagePreferenceViewModelState {
    failure?: Error;
    loading: boolean;
    preferences: MessagePreferencesSnapshot;
}

export class MessagePreferenceViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #transport: MessagePreferenceTransport;
    #generation = 0;
    #published: MessagePreferenceViewModelState = emptyMessagePreferenceViewModelState();
    #state: MessagePreferenceViewModelState = emptyMessagePreferenceViewModelState();

    constructor(transport: MessagePreferenceTransport) {
        this.#transport = transport;
    }

    get state(): Readonly<MessagePreferenceViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async refresh(): Promise<MessagePreferencesSnapshot | undefined> {
        const generation = ++this.#generation;
        this.#state = { ...this.#state, loading: true };
        this.#emit();
        try {
            const preferences = await this.#transport.getMessagePreferences();
            if (generation !== this.#generation) return undefined;
            this.#state = { loading: false, preferences };
            this.#emit();
            return preferences;
        } catch (error) {
            if (generation !== this.#generation) return undefined;
            this.#state = {
                ...this.#state,
                failure: messageError(error),
                loading: false,
            };
            this.#emit();
            return undefined;
        }
    }

    async update(patch: MessagePreferencesPatch): Promise<MessagePreferencesSnapshot> {
        const generation = ++this.#generation;
        const preferences = await this.#transport.updateMessagePreferences(patch);
        if (generation === this.#generation) {
            this.#state = { loading: false, preferences };
            this.#emit();
        }
        return preferences;
    }

    close(): void {
        this.#generation += 1;
        this.#listeners.clear();
        this.#state = emptyMessagePreferenceViewModelState();
        this.#published = this.#state;
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = { ...this.#state };
        for (const listener of this.#listeners) listener();
    }
}

function emptyMessagePreferenceViewModelState(): MessagePreferenceViewModelState {
    return {
        loading: false,
        preferences: createEmptyMessagePreferences(),
    };
}

function messageError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
