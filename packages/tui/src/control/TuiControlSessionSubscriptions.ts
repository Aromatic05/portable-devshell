import type { TuiClientRuntimeStreamMessage } from "../client/runtime/TuiClientRuntimeStream.js";

export interface TuiControlSessionSubscriptionsOptions {
    onConnectionClosed(instance: string): void;
    onEvent(
        message: Extract<
            TuiClientRuntimeStreamMessage,
            { kind: "instance.event" }
        >
    ): void;
    onGap(instance: string): Promise<void>;
    onSubscribeError(instance: string, error: unknown): Promise<void>;
    subscribe(
        instance: string,
        fromSeq: number
    ): Promise<TuiControlRuntimeStream>;
}

export interface TuiControlRuntimeStream {
    close(): void;
    nextMessage(): Promise<TuiClientRuntimeStreamMessage>;
}

export class TuiControlSessionSubscriptions {
    readonly #options: TuiControlSessionSubscriptionsOptions;
    readonly #subscriptions = new Map<
        string,
        TuiControlInstanceSubscription
    >();

    constructor(options: TuiControlSessionSubscriptionsOptions) {
        this.#options = options;
    }

    get size(): number {
        return this.#subscriptions.size;
    }

    replaceAll(
        requests: ReadonlyArray<{ fromSeq: number; instance: string }>
    ): void {
        const requested = new Set(requests.map((request) => request.instance));
        for (const instance of this.#subscriptions.keys()) {
            if (!requested.has(instance)) {
                this.closeInstance(instance);
            }
        }
        for (const request of requests) {
            this.subscribeInstance(request.instance, request.fromSeq);
        }
    }

    subscribeInstance(instance: string, fromSeq: number): void {
        this.closeInstance(instance);
        const subscription = new TuiControlInstanceSubscription({
            fromSeq,
            instance,
            onConnectionClosed: () => {
                this.#subscriptions.delete(instance);
                this.#options.onConnectionClosed(instance);
            },
            onEvent: this.#options.onEvent,
            onGap: async () => {
                this.#subscriptions.delete(instance);
                await this.#options.onGap(instance);
            },
            onSubscribeError: async (error) => {
                this.#subscriptions.delete(instance);
                await this.#options.onSubscribeError(instance, error);
            },
            subscribe: async (requestedFromSeq) => {
                return await this.#options.subscribe(
                    instance,
                    requestedFromSeq
                );
            }
        });
        this.#subscriptions.set(instance, subscription);
        void subscription.start();
    }

    closeInstance(instance: string): void {
        const subscription = this.#subscriptions.get(instance);
        if (subscription === undefined) {
            return;
        }
        this.#subscriptions.delete(instance);
        subscription.close();
    }

    closeAll(): void {
        for (const subscription of this.#subscriptions.values()) {
            subscription.close();
        }
        this.#subscriptions.clear();
    }
}

interface TuiControlInstanceSubscriptionOptions {
    fromSeq: number;
    instance: string;
    onConnectionClosed(): void;
    onEvent(
        message: Extract<
            TuiClientRuntimeStreamMessage,
            { kind: "instance.event" }
        >
    ): void;
    onGap(): Promise<void>;
    onSubscribeError(error: unknown): Promise<void>;
    subscribe(fromSeq: number): Promise<TuiControlRuntimeStream>;
}

class TuiControlInstanceSubscription {
    readonly #fromSeq: number;
    readonly #instance: string;
    readonly #onConnectionClosed: () => void;
    readonly #onEvent: TuiControlInstanceSubscriptionOptions["onEvent"];
    readonly #onGap: () => Promise<void>;
    readonly #onSubscribeError: (error: unknown) => Promise<void>;
    readonly #subscribe: TuiControlInstanceSubscriptionOptions["subscribe"];
    #closed = false;
    #stream?: TuiControlRuntimeStream;

    constructor(options: TuiControlInstanceSubscriptionOptions) {
        this.#fromSeq = options.fromSeq;
        this.#instance = options.instance;
        this.#onConnectionClosed = options.onConnectionClosed;
        this.#onEvent = options.onEvent;
        this.#onGap = options.onGap;
        this.#onSubscribeError = options.onSubscribeError;
        this.#subscribe = options.subscribe;
    }

    async start(): Promise<void> {
        try {
            this.#stream = await this.#subscribe(this.#fromSeq);
            while (!this.#closed) {
                const message = await this.#stream.nextMessage();
                if (this.#closed) {
                    return;
                }
                const terminal = await this.#handleMessage(message);
                if (terminal) {
                    return;
                }
            }
        } catch (error) {
            if (this.#closed) {
                return;
            }
            this.close();
            await this.#onSubscribeError(error);
        }
    }

    close(): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#stream?.close();
    }

    async #handleMessage(
        message: TuiClientRuntimeStreamMessage
    ): Promise<boolean> {
        switch (message.kind) {
            case "instance.event":
                if (message.event.destination === this.#instance) {
                    this.#onEvent(message);
                }
                return false;
            case "stream.gap":
                this.close();
                await this.#onGap();
                return true;
            case "stream.cancelled":
            case "connection.closed":
                this.close();
                this.#onConnectionClosed();
                return true;
        }
    }
}
