import { createRemoteError } from "../../transport/Error.js";
import { STREAM_GAP_CODE } from "../../client/Stream.js";
import type { InstanceEventRecord } from "../../client/Stream.js";
import type { JsonValue } from "../../types/Json.js";
import type { ControlPortContext } from "../../control/server/Route.js";
import type { MessageStream } from "../../transport/packet/Stream.js";


interface ProcessEventSource {
    subscribe(fromSeq?: number):
        | {
              code: typeof STREAM_GAP_CODE;
              fromSeq: number;
              kind: "gap";
              lastSeq: number;
              nextSeq: number;
          }
        | { events: InstanceEventRecord[]; kind: "events"; lastSeq: number };
}

export type ProcessEventProjector = (
    event: InstanceEventRecord,
) => InstanceEventRecord | undefined;

export interface ProcessSubscription {
    connectionId: string;
    projectEvent?: ProcessEventProjector;
    instance: ProcessEventSource;
    instanceName: string;
    nextSeq: number;
    requestId: string;
    stream: MessageStream;
}

interface ManagedSubscription extends ProcessSubscription {
    controller: AbortController;
    draining: boolean;
    detach(): void;
}

interface ProcessEventWatch {
    projectEvent?: ProcessEventProjector;
    instance: ProcessSubscription["instance"];
    instanceName: string;
    nextSeq: number;
    onEvent(event: InstanceEventRecord): Promise<void> | void;
    onGap(gap: {
        lastSeq: number;
        nextSeq: number;
    }): Promise<number | void> | number | void;
    reject(error: unknown): void;
    resolve(): void;
    signal: AbortSignal;
}

export class ProcessSubscriptionManager {
    readonly #pollIntervalMs: number;
    readonly #subscriptions = new Map<string, ManagedSubscription>();
    readonly #watches = new Map<number, ProcessEventWatch>();
    #nextWatchId = 1;
    #timer?: NodeJS.Timeout;
    #pollPromise?: Promise<void>;

    constructor(pollIntervalMs = 25) {
        this.#pollIntervalMs = pollIntervalMs;
    }

    async subscribe(
        stream: MessageStream,
        context: ControlPortContext,
        instanceName: string,
        instance: ProcessSubscription["instance"],
        fromSeq: number,
        projectEvent?: ProcessEventProjector,
    ): Promise<void> {
        const slice = instance.subscribe(fromSeq);
        if (slice.kind === "gap") {
            throw createRemoteError({
                code: STREAM_GAP_CODE,
                message:
                    "Requested event sequence is no longer available. Pull a fresh snapshot.",
                retryable: true,
                details: {
                    instance: instanceName,
                    latestSeq: slice.lastSeq,
                    oldestAvailableSeq: slice.nextSeq,
                    requestedFromSeq: fromSeq,
                },
            });
        }

        const key = this.#key(context.connectionId, context.requestId);
        const controller = new AbortController();
        const subscription: ManagedSubscription = {
            connectionId: context.connectionId,
            projectEvent, instance, instanceName,
            nextSeq: slice.lastSeq + 1,
            requestId: context.requestId,
            stream, controller, draining: true,
            detach: () => { offClose(); offCancel(); },
        };
        const close = () => this.#removeSubscription(key, subscription);
        const offClose = stream.onClose(close);
        const offCancel = stream.onCancel(close);
        const previous = this.#subscriptions.get(key);
        if (previous !== undefined) this.#removeSubscription(key, previous);
        this.#subscriptions.set(key, subscription);
        try {
            await this.#send(subscription, {
                name: "seed",
                payload: {
                    events: slice.events.flatMap((event) => {
                        const projected =
                            projectEvent === undefined
                                ? event
                                : projectEvent(event);
                        return projected === undefined ? [] : [projected];
                    }) as unknown as JsonValue,
                    lastSeq: slice.lastSeq,
                },
            });
            controller.signal.throwIfAborted();
        } catch (error) {
            close();
            throw error;
        }
        subscription.draining = false;
        this.#ensurePolling();
    }

    async watch(
        instanceName: string,
        instance: ProcessSubscription["instance"],
        fromSeq: number,
        signal: AbortSignal,
        handlers: {
            projectEvent?: ProcessEventProjector;
            onEvent(event: InstanceEventRecord): Promise<void> | void;
            onGap(gap: {
                lastSeq: number;
                nextSeq: number;
            }): Promise<number | void> | number | void;
        },
    ): Promise<void> {
        signal.throwIfAborted();
        const seed: ProcessEventWatch = {
            projectEvent: handlers.projectEvent,
            instance,
            instanceName,
            nextSeq: fromSeq,
            onEvent: handlers.onEvent,
            onGap: handlers.onGap,
            reject: () => undefined,
            resolve: () => undefined,
            signal,
        };
        seed.nextSeq = await this.#deliverWatchSlice(seed);
        signal.throwIfAborted();

        await new Promise<void>((resolve, reject) => {
            const id = this.#nextWatchId++;
            const aborted = () => {
                if (this.#watches.delete(id)) resolve();
                this.#stopPollingWhenIdle();
            };
            const watch: ProcessEventWatch = {
                ...seed,
                reject: (error) => {
                    signal.removeEventListener("abort", aborted);
                    reject(error);
                },
                resolve: () => {
                    signal.removeEventListener("abort", aborted);
                    resolve();
                },
            };
            signal.addEventListener("abort", aborted, { once: true });
            this.#watches.set(id, watch);
            this.#ensurePolling();
        });
    }

    unsubscribeConnection(connectionId: string): void {
        for (const [key, subscription] of this.#subscriptions) {
            if (subscription.connectionId === connectionId)
                this.#removeSubscription(key, subscription);
        }
        this.#stopPollingWhenIdle();
    }

    close(): void {
        for (const [key, subscription] of this.#subscriptions)
            this.#removeSubscription(key, subscription);
        for (const watch of this.#watches.values()) watch.resolve();
        this.#watches.clear();
        if (this.#timer !== undefined) {
            clearInterval(this.#timer);
            this.#timer = undefined;
        }
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
        for (const [key, subscription] of this.#subscriptions) {
            if (subscription.draining) continue;
            subscription.draining = true;
            void this.#drainSubscription(key, subscription);
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

    async #drainSubscription(key: string, subscription: ManagedSubscription): Promise<void> {
        try {
            // One retained source slice and one pending send per subscription.
            // Slow Channels never queue more slices or block another drain.
            const slice = subscription.instance.subscribe(subscription.nextSeq);
            if (slice.kind === "gap") {
                await this.#send(subscription, {
                    name: "gap",
                    payload: {
                        instance: subscription.instanceName,
                        latestSeq: slice.lastSeq,
                        oldestAvailableSeq: slice.nextSeq,
                        requestedFromSeq: subscription.nextSeq,
                    },
                    seq: slice.lastSeq,
                });
                subscription.nextSeq = slice.nextSeq;
                return;
            }
            for (const event of slice.events) {
                subscription.controller.signal.throwIfAborted();
                const projected = subscription.projectEvent === undefined
                    ? event : subscription.projectEvent(event);
                if (projected === undefined) continue;
                await this.#send(subscription, {
                    name: "event",
                    payload: projected as unknown as JsonValue,
                    seq: projected.seq,
                });
            }
            subscription.nextSeq = slice.lastSeq + 1;
        } catch {
            this.#removeSubscription(key, subscription);
        } finally {
            subscription.draining = false;
        }
    }

    async #send(subscription: ManagedSubscription, message: Parameters<MessageStream["send"]>[0]): Promise<void> {
        const signal = subscription.controller.signal;
        signal.throwIfAborted();
        let abort!: () => void;
        const stopped = new Promise<never>((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
        });
        try {
            await Promise.race([subscription.stream.send(message), stopped]);
        } finally {
            signal.removeEventListener("abort", abort);
        }
    }

    #removeSubscription(key: string, subscription: ManagedSubscription): void {
        if (this.#subscriptions.get(key) !== subscription) return;
        this.#subscriptions.delete(key);
        subscription.detach();
        subscription.controller.abort();
        this.#stopPollingWhenIdle();
    }

    async #deliverWatchSlice(watch: ProcessEventWatch): Promise<number> {
        const slice = watch.instance.subscribe(watch.nextSeq);
        if (slice.kind === "gap") {
            const recovered = await watch.onGap({
                lastSeq: slice.lastSeq,
                nextSeq: slice.nextSeq,
            });
            return recovered ?? slice.nextSeq;
        }
        for (const event of slice.events) {
            const projected =
                watch.projectEvent === undefined
                    ? event
                    : watch.projectEvent(event);
            if (projected === undefined) continue;
            await watch.onEvent(projected);
        }
        return slice.lastSeq + 1;
    }

    #key(connectionId: string, requestId: string): string {
        return `${connectionId}:${requestId}`;
    }

    #stopPollingWhenIdle(): void {
        if (
            this.#subscriptions.size > 0 ||
            this.#watches.size > 0 ||
            this.#timer === undefined
        )
            return;
        clearInterval(this.#timer);
        this.#timer = undefined;
    }
}
