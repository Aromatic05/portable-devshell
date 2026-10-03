import { type InstanceEvent } from "../../execution/process/Event.js";
import {
    InstanceEventSubscription,
    type InstanceEventSubscriptionStatus,
} from "../../execution/process/Event.js";
import {
    type ContextMessageListInput,
    type ContextMessageRecord,
    type ConversationEntry,
    isContextMessageEvent,
    isConversationEvent,
    mergeContextMessage,
    mergeContextMessageList,
    mergeConversationEntryList,
} from "./Model.js";
import type { MessageTransport } from "./Transport.js";

export interface MessageInstanceState {
    lastSeq: number;
    messages: ContextMessageRecord[];
    status: InstanceEventSubscriptionStatus;
}
export interface MessageViewModelState {
    failures: Record<string, Error>;
    instances: Record<string, MessageInstanceState>;
}
export interface MessageViewModelOptions {
    onEvent?(event: InstanceEvent): void;
    transport: MessageTransport;
}
const REFRESH_DELAY_MS = 100;
const MESSAGE_LIST_LIMIT = 400;
const MESSAGE_LIST_MAX_BYTES = 1024 * 1024;
export class MessageViewModel {
    readonly #transport: MessageTransport;
    readonly #listeners = new Set<() => void>();
    readonly #onEvent?: (event: InstanceEvent) => void;
    readonly #versions = new Map<string, number>();
    readonly #refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #subscriptions = new Map<string, InstanceEventSubscription>();
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
export function createInitialMessageViewModelState(): MessageViewModelState {
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
export interface ConversationInstanceState {
    entries: ConversationEntry[];
    lastSeq: number;
    status: InstanceEventSubscriptionStatus;
}
export interface ConversationViewModelState {
    failures: Record<string, Error>;
    instances: Record<string, ConversationInstanceState>;
}
export interface ConversationViewModelOptions {
    transport: MessageTransport;
    onEvent?(event: InstanceEvent): void;
}
const CONVERSATION_REFRESH_DELAY_MS = 100;
const CONVERSATION_LIST_LIMIT = 400;
const CONVERSATION_LIST_MAX_BYTES = 1024 * 1024;
export class ConversationViewModel {
    readonly #transport: MessageTransport;
    readonly #listeners = new Set<() => void>();
    readonly #onEvent?: (event: InstanceEvent) => void;
    readonly #versions = new Map<string, number>();
    readonly #refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #subscriptions = new Map<string, InstanceEventSubscription>();
    #epoch = 0;
    #publishedState: ConversationViewModelState =
        createInitialConversationViewModelState();
    #state: ConversationViewModelState =
        createInitialConversationViewModelState();

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
     * Reads the authoritative Conversation snapshot. Returns the read-time
     * instance sequence so the caller can resume from lastSeq + 1.
     */
    async refreshInstance(instance: string): Promise<number | undefined> {
        const key = this.#instanceVersionKey(instance);
        const epoch = this.#epoch;
        const version = this.#nextVersion(key);
        try {
            const result = await this.#transport.listConversationEntries(
                instance,
                {
                    limit: CONVERSATION_LIST_LIMIT,
                    maxBytes: CONVERSATION_LIST_MAX_BYTES,
                },
            );
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
        }, CONVERSATION_REFRESH_DELAY_MS);
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
    };
}
function createInitialConversationInstanceState(): ConversationInstanceState {
    return {
        entries: [],
        lastSeq: 0,
        status: "stopped",
    };
}
