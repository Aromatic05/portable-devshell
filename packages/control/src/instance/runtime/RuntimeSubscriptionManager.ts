import {
    createError,
    errorCodes,
    type InstanceEvent,
    type JsonValue,
    type PrefixRouteContext
} from "@portable-devshell/shared";

import type { RuntimeSubscription } from "./RuntimeSubscription.js";

export class RuntimeSubscriptionManager {
    readonly #pollIntervalMs: number;
    readonly #subscriptions = new Map<string, RuntimeSubscription>();
    #timer?: NodeJS.Timeout;

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

    unsubscribeConnection(connectionId: string): void {
        for (const [key, subscription] of this.#subscriptions) {
            if (subscription.connectionId === connectionId) {
                this.#subscriptions.delete(key);
            }
        }
        this.#stopPollingWhenIdle();
    }

    #ensurePolling(): void {
        if (this.#timer !== undefined) {
            return;
        }
        this.#timer = setInterval(() => {
            void this.#poll();
        }, this.#pollIntervalMs);
    }

    async #poll(): Promise<void> {
        for (const [key, subscription] of [...this.#subscriptions]) {
            const slice = subscription.instance.subscribe(subscription.nextSeq);
            try {
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
                    if (subscription.eventFilter !== undefined && !subscription.eventFilter(event)) {
                        continue;
                    }
                    const [module, operation] = splitEventType(event.type);
                    await subscription.stream.emit(operation, event as unknown as JsonValue, event.seq, module);
                }
                subscription.nextSeq = slice.lastSeq + 1;
            } catch {
                this.#subscriptions.delete(key);
            }
        }
        this.#stopPollingWhenIdle();
    }

    #key(connectionId: string, requestId: string): string {
        return `${connectionId}:${requestId}`;
    }

    #stopPollingWhenIdle(): void {
        if (this.#subscriptions.size > 0 || this.#timer === undefined) {
            return;
        }
        clearInterval(this.#timer);
        this.#timer = undefined;
    }
}

function splitEventType(type: string): [module: string, operation: string] {
    const segments = type.split(".");
    if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z][A-Za-z0-9]*$/.test(segment))) {
        throw new Error(`Invalid instance event type: ${type}`);
    }
    return [segments[0]!, segments[1]!];
}
