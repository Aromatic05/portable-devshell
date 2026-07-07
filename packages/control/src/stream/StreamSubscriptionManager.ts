import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

import type { ControlRpcConnection } from "../control/rpc/ControlRpcConnection.js";
import type { StreamSubscriptionInstance } from "./subscription/StreamSubscriptionInstance.js";

export class StreamSubscriptionManager {
    readonly #pollIntervalMs: number;
    readonly #subscriptions = new Map<string, StreamSubscriptionInstance>();
    #timer?: NodeJS.Timeout;

    constructor(pollIntervalMs = 25) {
        this.#pollIntervalMs = pollIntervalMs;
    }

    async subscribe(connection: ControlRpcConnection, instanceName: string, instance: StreamSubscriptionInstance["instance"], fromSeq: number): Promise<JsonValue> {
        const slice = instance.subscribe(fromSeq);

        if (slice.kind === "gap") {
            throw createError({
                code: errorCodes.streamGap,
                message: "Requested event sequence is no longer available. Pull a fresh snapshot.",
                retryable: true,
                details: {
                    instance: instanceName,
                    oldestAvailableSeq: slice.nextSeq,
                    requestedFromSeq: fromSeq
                }
            });
        }

        this.#subscriptions.set(this.#key(connection.id, instanceName), {
            connection,
            connectionId: connection.id,
            instance,
            instanceName,
            nextSeq: slice.lastSeq + 1
        });
        this.#ensurePolling();

        return {
            events: slice.events,
            lastSeq: slice.lastSeq
        } as unknown as JsonValue;
    }

    unsubscribeConnection(connectionId: string): void {
        for (const key of this.#subscriptions.keys()) {
            if (key.startsWith(`${connectionId}:`)) {
                this.#subscriptions.delete(key);
            }
        }

        if (this.#subscriptions.size === 0 && this.#timer !== undefined) {
            clearInterval(this.#timer);
            this.#timer = undefined;
        }
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
                this.#subscriptions.delete(key);
                continue;
            }

            for (const event of slice.events) {
                await subscription.connection.sendEvent({
                    event: event.type,
                    payload: event as unknown as JsonValue,
                    seq: event.seq,
                    target: {
                        instance: subscription.instanceName,
                        kind: "instance"
                    },
                    type: "event"
                });
            }

            subscription.nextSeq = slice.lastSeq + 1;
        }
    }

    #key(connectionId: string, instanceName: string): string {
        return `${connectionId}:${instanceName}`;
    }
}
