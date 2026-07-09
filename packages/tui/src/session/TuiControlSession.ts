import type { ApprovalRequest, ControlErrorBody, InstanceSnapshot, ToolCallRecord } from "@portable-devshell/shared";

import type { TuiControlClientLike } from "../control/TuiControlClient.js";
import { TuiControlClient } from "../control/TuiControlClient.js";
import type { TuiControlEventEnvelope } from "../control/TuiControlRequest.js";
import type { TuiControlStreamMessage } from "../control/TuiControlStream.js";
import { TuiViewModelStore } from "../model/TuiViewModelStore.js";

export interface TuiControlSessionOptions {
    client?: TuiControlClientLike;
    reconnectController?: TuiReconnectController;
    reconnectDelayMs?: number;
    store?: TuiViewModelStore;
}

export class TuiReconnectController {
    readonly #listeners = new Set<() => void>();

    requestReconnect(): void {
        for (const listener of this.#listeners) {
            listener();
        }
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }
}

export class TuiControlSession {
    readonly #client: TuiControlClientLike;
    readonly #reconnectController: TuiReconnectController;
    readonly #store: TuiViewModelStore;
    readonly #reconnectDelayMs: number;
    readonly #subscriptionRecoveryTimers = new Map<string, NodeJS.Timeout>();
    readonly #subscriptions = new Map<string, TuiInstanceSubscription>();
    #active = false;
    #connectPromise?: Promise<void>;
    #reconnectTimer?: NodeJS.Timeout;

    constructor(options: TuiControlSessionOptions = {}) {
        this.#client = options.client ?? new TuiControlClient();
        this.#reconnectController = options.reconnectController ?? new TuiReconnectController();
        this.#store = options.store ?? new TuiViewModelStore();
        this.#reconnectDelayMs = options.reconnectDelayMs ?? 250;
        this.#reconnectController.subscribe(() => {
            void this.reconnect();
        });
    }

    get store(): TuiViewModelStore {
        return this.#store;
    }

    async start(): Promise<void> {
        if (this.#active) {
            return await (this.#connectPromise ?? Promise.resolve());
        }

        this.#active = true;
        await this.#connectAll();
    }

    async stop(): Promise<void> {
        this.#active = false;
        if (this.#reconnectTimer !== undefined) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = undefined;
        }
        this.#clearSubscriptionRecoveryTimers();
        this.#closeSubscriptions();
    }

    async reconnect(): Promise<void> {
        if (!this.#active) {
            return;
        }

        await this.#connectAll(true);
    }

    async #connectAll(force = false): Promise<void> {
        if (this.#connectPromise !== undefined) {
            return await this.#connectPromise;
        }

        this.#connectPromise = (async () => {
            if (force) {
                this.#closeSubscriptions();
            }

            this.#store.setConnectionState("connecting");

            try {
                const instances = await this.#client.listInstances();
                this.#store.resetInstances(instances);
                this.#store.setConfigView(await this.#client.getConfigView());

                for (const instance of instances) {
                    const loaded = await this.#loadInstance(instance.name);
                    this.#subscribeInstance(instance.name, loaded.snapshot.lastSeq + 1);
                }

                this.#store.setConnectionState("connected");
            } catch (error) {
                const failure = toFailure(error);
                this.#store.setConnectionState(failure.state, failure.error);
                this.#closeSubscriptions();
                this.#scheduleReconnect();
            } finally {
                this.#connectPromise = undefined;
            }
        })();

        return await this.#connectPromise;
    }

    async #loadInstance(instance: string): Promise<{ approvals: ApprovalRequest[]; snapshot: InstanceSnapshot; toolCalls: ToolCallRecord[] }> {
        const snapshotEnvelope = await this.#client.getSnapshot(instance);
        const toolCalls = await this.#client.readToolCalls(instance);
        const approvals = await this.#client.listApprovals(instance);

        this.#store.upsertSnapshot(snapshotEnvelope.snapshot as InstanceSnapshot);
        this.#store.replaceToolCalls(instance, toolCalls);
        this.#store.replaceApprovals(instance, approvals);

        return {
            approvals,
            snapshot: snapshotEnvelope.snapshot as InstanceSnapshot,
            toolCalls
        };
    }

    #subscribeInstance(instance: string, fromSeq: number): void {
        this.#subscriptions.get(instance)?.close();
        const subscription = new TuiInstanceSubscription({
            instance,
            onCancelled: (reason) => {
                if (reason === "gap" || reason === "client.closed") {
                    return;
                }

                this.#handleDisconnected();
            },
            onClosed: () => {
                this.#handleDisconnected();
            },
            onEvent: (envelope) => {
                this.#store.applyEvent(envelope);
            },
            onGap: async () => {
                await this.#recoverInstance(instance);
            },
            subscribe: async (requestedFromSeq) => await this.#client.subscribe(instance, requestedFromSeq)
        });
        this.#subscriptions.set(instance, subscription);
        void subscription.start(fromSeq).catch(async () => {
            if (this.#subscriptions.get(instance) !== subscription) {
                return;
            }

            this.#scheduleSubscriptionRecovery(instance, subscription);
        });
    }

    async #recoverInstance(instance: string): Promise<void> {
        if (!this.#active) {
            return;
        }

        try {
            const loaded = await this.#loadInstance(instance);
            this.#subscribeInstance(instance, loaded.snapshot.lastSeq + 1);
        } catch (error) {
            const failure = toFailure(error);
            this.#store.setConnectionState(failure.state, failure.error);
            this.#handleDisconnected();
        }
    }

    #handleDisconnected(): void {
        if (!this.#active) {
            return;
        }

        this.#store.setConnectionState("disconnected");
        this.#closeSubscriptions();
        this.#scheduleReconnect();
    }

    #scheduleReconnect(): void {
        if (!this.#active || this.#reconnectTimer !== undefined) {
            return;
        }

        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = undefined;
            void this.#connectAll(true);
        }, this.#reconnectDelayMs);
    }

    #closeSubscriptions(): void {
        for (const subscription of this.#subscriptions.values()) {
            subscription.close();
        }

        this.#subscriptions.clear();
    }

    #scheduleSubscriptionRecovery(instance: string, subscription: TuiInstanceSubscription): void {
        if (!this.#active || this.#subscriptionRecoveryTimers.has(instance)) {
            return;
        }

        const timer = setTimeout(() => {
            this.#subscriptionRecoveryTimers.delete(instance);

            if (!this.#active || this.#subscriptions.get(instance) !== subscription) {
                return;
            }

            void this.#recoverInstance(instance);
        }, this.#reconnectDelayMs);

        this.#subscriptionRecoveryTimers.set(instance, timer);
    }

    #clearSubscriptionRecoveryTimers(): void {
        for (const timer of this.#subscriptionRecoveryTimers.values()) {
            clearTimeout(timer);
        }

        this.#subscriptionRecoveryTimers.clear();
    }
}

interface TuiInstanceSubscriptionOptions {
    instance: string;
    onCancelled(reason: string): void;
    onClosed(): void;
    onEvent(envelope: TuiControlEventEnvelope): void;
    onGap(): Promise<void>;
    subscribe(fromSeq: number): Promise<{ close(): void; nextMessage(): Promise<TuiControlStreamMessage> }>;
}

class TuiInstanceSubscription {
    readonly #instance: string;
    readonly #onCancelled: (reason: string) => void;
    readonly #onClosed: () => void;
    readonly #onEvent: (envelope: TuiControlEventEnvelope) => void;
    readonly #onGap: () => Promise<void>;
    readonly #subscribe: TuiInstanceSubscriptionOptions["subscribe"];
    #closed = false;
    #stream?: { close(): void; nextMessage(): Promise<TuiControlStreamMessage> };

    constructor(options: TuiInstanceSubscriptionOptions) {
        this.#instance = options.instance;
        this.#onCancelled = options.onCancelled;
        this.#onClosed = options.onClosed;
        this.#onEvent = options.onEvent;
        this.#onGap = options.onGap;
        this.#subscribe = options.subscribe;
    }

    async start(fromSeq: number): Promise<void> {
        this.#stream = await this.#subscribe(fromSeq);

        while (!this.#closed) {
            const message = await this.#stream.nextMessage();

            if (this.#closed) {
                return;
            }

            if (message.kind === "instance.event") {
                if (message.envelope.target.instance === this.#instance) {
                    this.#onEvent(message.envelope);
                }
                continue;
            }

            if (message.kind === "stream.gap") {
                this.close();
                await this.#onGap();
                return;
            }

            if (message.kind === "stream.cancelled") {
                this.close();
                this.#onCancelled(message.envelope.payload.reason);
                return;
            }

            this.close();
            this.#onClosed();
            return;
        }
    }

    close(): void {
        if (this.#closed) {
            return;
        }

        this.#closed = true;
        this.#stream?.close();
    }
}

function toFailure(error: unknown): { error: { code?: string; message?: string }; state: "disconnected" | "error" } {
    const body = readErrorBody(error);

    if (body?.code === "control.notRunning") {
        return {
            error: {
                code: body.code,
                message: body.message
            },
            state: "disconnected"
        };
    }

    return {
        error: {
            ...(body?.code === undefined ? {} : { code: body.code }),
            message: error instanceof Error ? error.message : body?.message ?? String(error)
        },
        state: "error"
    };
}

function readErrorBody(error: unknown): ControlErrorBody | undefined {
    if (typeof error !== "object" || error === null) {
        return undefined;
    }

    const candidate = error as {
        code?: unknown;
        message?: unknown;
        retryable?: unknown;
    };

    if (typeof candidate.message !== "string") {
        return undefined;
    }

    return {
        code: typeof candidate.code === "string" ? candidate.code : "error.unknown",
        message: candidate.message,
        retryable: typeof candidate.retryable === "boolean" ? candidate.retryable : false
    };
}
