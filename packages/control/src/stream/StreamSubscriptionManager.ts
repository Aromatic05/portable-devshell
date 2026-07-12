import { createError, createInstanceTarget, errorCodes, type InstanceEvent, type JsonValue } from "@portable-devshell/shared";

import type { ControlRpcConnection } from "../control/rpc/ControlRpcConnection.js";
import type { StreamSubscriptionInstance } from "./subscription/StreamSubscriptionInstance.js";

export class StreamSubscriptionManager {
    readonly #pollIntervalMs: number;
    readonly #subscriptions = new Map<string, StreamSubscriptionInstance>();
    #timer?: NodeJS.Timeout;

    constructor(pollIntervalMs = 25) {
        this.#pollIntervalMs = pollIntervalMs;
    }

    async subscribe(
        connection: ControlRpcConnection,
        instanceName: string,
        instance: StreamSubscriptionInstance["instance"],
        fromSeq: number,
        eventFilter?: (event: InstanceEvent) => boolean
    ): Promise<JsonValue> {
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

        this.#subscriptions.set(this.#key(connection.id, instanceName), {
            connection,
            connectionId: connection.id,
            eventFilter,
            instance,
            instanceName,
            nextSeq: slice.lastSeq + 1
        });
        this.#ensurePolling();

        return {
            events: eventFilter === undefined ? slice.events : slice.events.filter(eventFilter),
            lastSeq: slice.lastSeq
        } as unknown as JsonValue;
    }

    unsubscribeConnection(connectionId: string): void {
        for (const key of this.#subscriptions.keys()) {
            if (key.startsWith(`${connectionId}:`)) {
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
        for (const [key, subscription] of this.#subscriptions) {
            const slice = subscription.instance.subscribe(subscription.nextSeq);

            if (slice.kind === "gap") {
                await subscription.connection.sendEvent({
                    event: "stream.gap",
                    payload: {
                        instance: subscription.instanceName,
                        latestSeq: slice.lastSeq,
                        oldestAvailableSeq: slice.nextSeq,
                        requestedFromSeq: subscription.nextSeq
                    } as unknown as JsonValue,
                    seq: slice.lastSeq,
                    target: createInstanceTarget(subscription.instanceName),
                    type: "event"
                });
                await subscription.connection.sendEvent({
                    event: "stream.cancelled",
                    payload: {
                        instance: subscription.instanceName,
                        reason: "gap"
                    } as unknown as JsonValue,
                    seq: slice.lastSeq,
                    target: createInstanceTarget(subscription.instanceName),
                    type: "event"
                });
                this.#subscriptions.delete(key);
                this.#stopPollingWhenIdle();
                continue;
            }

            for (const event of slice.events) {
                if (subscription.eventFilter !== undefined && !subscription.eventFilter(event)) {
                    continue;
                }
                await subscription.connection.sendEvent({
                    event: event.type,
                    payload: event as unknown as JsonValue,
                    seq: event.seq,
                    target: createInstanceTarget(subscription.instanceName),
                    type: "event"
                });
            }

            subscription.nextSeq = slice.lastSeq + 1;
        }
    }

    #key(connectionId: string, instanceName: string): string {
        return `${connectionId}:${instanceName}`;
    }

    #stopPollingWhenIdle(): void {
        if (this.#subscriptions.size > 0 || this.#timer === undefined) {
            return;
        }

        clearInterval(this.#timer);
        this.#timer = undefined;
    }
}
