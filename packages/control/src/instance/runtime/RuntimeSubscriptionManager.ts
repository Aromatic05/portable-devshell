import {
    createError,
    errorCodes,
    type InstanceEvent,
    type JsonValue,
    type PrefixRouteContext
} from "@portable-devshell/shared";

import type { RuntimeSubscription } from "./RuntimeSubscription.js";

interface RuntimeEventWatch {
    eventFilter?: (event: InstanceEvent) => boolean;
    instance: RuntimeSubscription["instance"];
    instanceName: string;
    nextSeq: number;
    onEvent(event: InstanceEvent): Promise<void> | void;
    onGap(gap: { lastSeq: number; nextSeq: number }): Promise<number | void> | number | void;
    reject(error: unknown): void;
    resolve(): void;
    signal: AbortSignal;
}

export class RuntimeSubscriptionManager {
    readonly #pollIntervalMs: number;
    readonly #subscriptions = new Map<string, RuntimeSubscription>();
    readonly #watches = new Map<number, RuntimeEventWatch>();
    #nextWatchId = 1;
    #timer?: NodeJS.Timeout;
    #pollPromise?: Promise<void>;

    constructor(pollIntervalMs = 25) {
        this.#pollIntervalMs = pollIntervalMs;
    }

    async subscribe(
        context: PrefixRouteContext,
        instanceName: string,
        instance: RuntimeSubscription["instance"],
        fromSeq: number,
        eventFilter?: (event: InstanceEvent) => boolean
    ): Promise<void> {
        const slice = instance.subscribe(fromSeq);
        if (slice.kind === "gap") {
            throw createError({
                code: errorCodes.streamGap,
                message: "Requested event sequence is no longer available. Pull a fresh snapshot.",
                retryable: true,
                details: {
                    instance: instanceName,
                    latestSeq: slice.lastSeq,
                    oldestAvailableSeq: slice.nextSeq,
                    requestedFromSeq: fromSeq
                }
            });
        }

        const key = this.#key(context.connectionId, context.requestId);
        const stream = await context.openStream(
            {
                events: (eventFilter === undefined ? slice.events : slice.events.filter(eventFilter)) as unknown as JsonValue,
                lastSeq: slice.lastSeq
            },
            {
                onClose: () => {
                    this.#subscriptions.delete(key);
                    this.#stopPollingWhenIdle();
                }
            }
        );

        this.#subscriptions.set(key, {
            connectionId: context.connectionId,
            eventFilter,
            instance,
            instanceName,
            nextSeq: slice.lastSeq + 1,
            requestId: context.requestId,
            stream
        });
        this.#ensurePolling();
    }

    async watch(
        instanceName: string,
        instance: RuntimeSubscription["instance"],
        fromSeq: number,
        signal: AbortSignal,
        handlers: {
            eventFilter?: (event: InstanceEvent) => boolean;
            onEvent(event: InstanceEvent): Promise<void> | void;
            onGap(gap: { lastSeq: number; nextSeq: number }): Promise<number | void> | number | void;
        }
    ): Promise<void> {
        signal.throwIfAborted();
        const seed: RuntimeEventWatch = {
            eventFilter: handlers.eventFilter,
            instance,
            instanceName,
            nextSeq: fromSeq,
            onEvent: handlers.onEvent,
            onGap: handlers.onGap,
            reject: () => undefined,
            resolve: () => undefined,
            signal
        };
        seed.nextSeq = await this.#deliverWatchSlice(seed);
        signal.throwIfAborted();

        await new Promise<void>((resolve, reject) => {
            const id = this.#nextWatchId++;
            const aborted = () => {
                if (this.#watches.delete(id)) resolve();
                this.#stopPollingWhenIdle();
            };
            const watch: RuntimeEventWatch = {
                ...seed,
                reject: (error) => {
                    signal.removeEventListener("abort", aborted);
                    reject(error);
                },
                resolve: () => {
                    signal.removeEventListener("abort", aborted);
                    resolve();
                }
            };
            signal.addEventListener("abort", aborted, { once: true });
            this.#watches.set(id, watch);
            this.#ensurePolling();
        });
    }

    unsubscribeConnection(connectionId: string): void {
        for (const [key, subscription] of this.#subscriptions) {
            if (subscription.connectionId === connectionId) this.#subscriptions.delete(key);
        }
        this.#stopPollingWhenIdle();
    }

    #ensurePolling(): void {
        if (this.#timer !== undefined) return;
        this.#timer = setInterval(() => {
            void this.#poll();
        }, this.#pollIntervalMs);
    }

    async #poll(): Promise<void> {
        if (this.#pollPromise !== undefined) return await this.#pollPromise;
        const poll = this.#pollSubscriptions();
        this.#pollPromise = poll;
        try {
            await poll;
        } finally {
            if (this.#pollPromise === poll) this.#pollPromise = undefined;
        }
    }

    async #pollSubscriptions(): Promise<void> {
        for (const [key, subscription] of [...this.#subscriptions]) {
            try {
                const slice = subscription.instance.subscribe(subscription.nextSeq);
                if (slice.kind === "gap") {
                    await subscription.stream.emit(
                        "gap",
                        {
                            instance: subscription.instanceName,
                            latestSeq: slice.lastSeq,
                            oldestAvailableSeq: slice.nextSeq,
                            requestedFromSeq: subscription.nextSeq
                        },
                        slice.lastSeq,
                        "stream"
                    );
                    subscription.nextSeq = slice.nextSeq;
                    continue;
                }

                for (const event of slice.events) {
                    if (subscription.eventFilter !== undefined && !subscription.eventFilter(event)) continue;
                    const [module, operation] = splitEventType(event.type);
                    await subscription.stream.emit(operation, event as unknown as JsonValue, event.seq, module);
                }
                subscription.nextSeq = slice.lastSeq + 1;
            } catch {
                this.#subscriptions.delete(key);
            }
        }

        for (const [id, watch] of [...this.#watches]) {
            try {
                if (watch.signal.aborted) {
                    this.#watches.delete(id);
                    watch.resolve();
                    continue;
                }
                watch.nextSeq = await this.#deliverWatchSlice(watch);
            } catch (error) {
                this.#watches.delete(id);
                watch.reject(error);
            }
        }

        this.#stopPollingWhenIdle();
    }

    async #deliverWatchSlice(watch: RuntimeEventWatch): Promise<number> {
        const slice = watch.instance.subscribe(watch.nextSeq);
        if (slice.kind === "gap") {
            const recovered = await watch.onGap({ lastSeq: slice.lastSeq, nextSeq: slice.nextSeq });
            return recovered ?? slice.nextSeq;
        }
        for (const event of slice.events) {
            if (watch.eventFilter !== undefined && !watch.eventFilter(event)) continue;
            await watch.onEvent(event);
        }
        return slice.lastSeq + 1;
    }

    #key(connectionId: string, requestId: string): string {
        return `${connectionId}:${requestId}`;
    }

    #stopPollingWhenIdle(): void {
        if (this.#subscriptions.size > 0 || this.#watches.size > 0 || this.#timer === undefined) return;
        clearInterval(this.#timer);
        this.#timer = undefined;
    }
}

function splitEventType(type: string): [module: string, operation: string] {
    const segments = type.split(".");
    if (
        segments.length < 2 ||
        segments.some((segment) => !/^[A-Za-z][A-Za-z0-9]*$/u.test(segment))
    ) {
        throw new Error(`Invalid instance event type: ${type}`);
    }
    if (segments.length === 2) return [segments[0]!, segments[1]!];
    return ["instanceEvent", "published"];
}
