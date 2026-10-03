import type { WorkerInstance } from "../worker/instance/Instance.js";
import { createRemoteError, STREAM_GAP_CODE } from "@portable-devshell/shared";
import type {
    InstanceEventRecord,
    JsonValue,
    ControlPortContext,
    MessageStream,
} from "@portable-devshell/shared";

export type ProcessEventProjector = (
    event: InstanceEventRecord,
) => InstanceEventRecord | undefined;

export interface ProcessSubscription {
    connectionId: string;
    projectEvent?: ProcessEventProjector;
    instance: Pick<WorkerInstance, "subscribe">;
    instanceName: string;
    nextSeq: number;
    requestId: string;
    stream: MessageStream;
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
    readonly #subscriptions = new Map<string, ProcessSubscription>();
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
        await stream.send({
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
        const close = () => {
            this.#subscriptions.delete(key);
            this.#stopPollingWhenIdle();
        };
        stream.onClose(close);
        stream.onCancel(close);

        this.#subscriptions.set(key, {
            connectionId: context.connectionId,
            projectEvent,
            instance,
            instanceName,
            nextSeq: slice.lastSeq + 1,
            requestId: context.requestId,
            stream,
        });
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
                this.#subscriptions.delete(key);
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
                const slice = subscription.instance.subscribe(
                    subscription.nextSeq,
                );
                if (slice.kind === "gap") {
                    await subscription.stream.send({
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
                    continue;
                }

                for (const event of slice.events) {
                    const projected =
                        subscription.projectEvent === undefined
                            ? event
                            : subscription.projectEvent(event);
                    if (projected === undefined) continue;
                    await subscription.stream.send({
                        name: "event",
                        payload: projected as unknown as JsonValue,
                        seq: projected.seq,
                    });
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
