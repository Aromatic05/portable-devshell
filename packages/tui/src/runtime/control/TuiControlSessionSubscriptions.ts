import type { TuiClientRuntimeStreamMessage } from "../client/runtime/TuiClientRuntimeStream.js";
import { withTuiRequestTimeout } from "./TuiRequestTimeout.js";

export interface TuiControlSessionSubscriptionsOptions {
    currentSequence?(instance: string): number;
    onConnectionClosed(instance: string): void;
    onEvent(
        message: Extract<TuiClientRuntimeStreamMessage, { kind: "instance.event" }>
    ): void;
    onGap(
        instance: string,
        message: Extract<TuiClientRuntimeStreamMessage, { kind: "stream.gap" }>
    ): Promise<number | undefined | void>;
    onRecovered?(instance: string): void;
    onSubscribeError(instance: string, error: unknown): Promise<void>;
    random?: () => number;
    retryBaseMs?: number;
    stableAfterMs?: number;
    subscribeTimeoutMs?: number;
    subscribe(instance: string, fromSeq: number): Promise<TuiControlRuntimeStream>;
}

export interface TuiControlRuntimeStream {
    close(): void;
    nextMessage(): Promise<TuiClientRuntimeStreamMessage>;
}

export class TuiControlSessionSubscriptions {
    readonly #subscriptions = new Map<string, TuiControlRuntimeStream>();
    readonly #desired = new Map<string, number>();
    readonly #retries = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #stableTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #attempts = new Map<string, number>();
    readonly #gapStreaks = new Map<string, number>();
    readonly #tokens = new Map<string, number>();
    readonly #random: () => number;
    readonly #retryBaseMs: number;
    readonly #stableAfterMs: number;
    readonly #subscribeTimeoutMs: number;

    constructor(private readonly options: TuiControlSessionSubscriptionsOptions) {
        this.#random = options.random ?? Math.random;
        this.#retryBaseMs = options.retryBaseMs ?? 1_000;
        this.#stableAfterMs = options.stableAfterMs ?? Math.max(1_000, this.#retryBaseMs * 4);
        this.#subscribeTimeoutMs = options.subscribeTimeoutMs ?? 10_000;
    }

    get size(): number {
        return this.#subscriptions.size;
    }

    replaceAll(requests: ReadonlyArray<{ fromSeq: number; instance: string }>): void {
        const requested = new Set(requests.map((request) => request.instance));
        for (const instance of this.#desired.keys()) {
            if (!requested.has(instance)) this.closeInstance(instance);
        }
        for (const request of requests) this.subscribeInstance(request.instance, request.fromSeq);
    }

    subscribeInstance(instance: string, fromSeq: number): void {
        this.#desired.set(instance, fromSeq);
        void this.#start(instance, fromSeq);
    }

    closeInstance(instance: string): void {
        this.#desired.delete(instance);
        this.#tokens.set(instance, (this.#tokens.get(instance) ?? 0) + 1);
        this.#clearRetry(instance);
        this.#closeStream(instance);
        this.#clearStableTimer(instance);
        this.#attempts.delete(instance);
        this.#gapStreaks.delete(instance);
    }

    closeAll(): void {
        for (const instance of [...this.#desired.keys()]) this.closeInstance(instance);
        for (const instance of [...this.#subscriptions.keys()]) this.#closeStream(instance);
        this.#desired.clear();
    }

    async #start(instance: string, fromSeq: number): Promise<void> {
        if (!this.#desired.has(instance)) return;
        const token = (this.#tokens.get(instance) ?? 0) + 1;
        this.#tokens.set(instance, token);
        this.#clearRetry(instance);
        this.#closeStream(instance);
        this.#desired.set(instance, fromSeq);
        const request = this.options.subscribe(instance, fromSeq);
        let abandoned = false;
        void request.then(
            (stream) => {
                if (abandoned) this.#safeClose(stream);
            },
            () => undefined
        );
        try {
            const stream = await withTuiRequestTimeout(
                request,
                this.#subscribeTimeoutMs,
                `runtime.subscribe:${instance}`
            );
            if (!this.#desired.has(instance) || this.#tokens.get(instance) !== token) {
                abandoned = true;
                this.#safeClose(stream);
                return;
            }
            this.#subscriptions.set(instance, stream);
            this.options.onRecovered?.(instance);
            this.#armStableReset(instance, stream);
            void this.#consume(instance, stream, fromSeq, token);
        } catch (error) {
            abandoned = true;
            if (!this.#desired.has(instance) || this.#tokens.get(instance) !== token) return;
            await this.options.onSubscribeError(instance, error);
            this.#schedule(instance);
        }
    }

    async #consume(
        instance: string,
        stream: TuiControlRuntimeStream,
        fromSeq: number,
        token: number
    ): Promise<void> {
        while (
            this.#desired.has(instance) &&
            this.#tokens.get(instance) === token &&
            this.#subscriptions.get(instance) === stream
        ) {
            try {
                const message = await stream.nextMessage();
                if (
                    !this.#desired.has(instance) ||
                    this.#tokens.get(instance) !== token ||
                    this.#subscriptions.get(instance) !== stream
                ) return;
                switch (message.kind) {
                    case "instance.event":
                        this.#markStable(instance);
                        this.options.onEvent(message);
                        break;
                    case "stream.gap": {
                        this.#closeStream(instance, stream);
                        const next = await this.options.onGap(instance, message);
                        if (!this.#desired.has(instance)) return;
                        if (typeof next === "number" && next > fromSeq) {
                            const streak = (this.#gapStreaks.get(instance) ?? 0) + 1;
                            this.#gapStreaks.set(instance, streak);
                            if (streak === 1) {
                                this.#desired.set(instance, next);
                                await this.#start(instance, next);
                            } else {
                                await this.options.onSubscribeError(
                                    instance,
                                    new Error(`Subscription produced ${streak} consecutive gaps.`)
                                );
                                this.#schedule(instance);
                            }
                        } else {
                            if (next !== undefined) {
                                await this.options.onSubscribeError(
                                    instance,
                                    new Error(`Subscription gap did not advance beyond sequence ${fromSeq}.`)
                                );
                            }
                            this.#schedule(instance);
                        }
                        return;
                    }
                    case "stream.cancelled":
                        this.#closeStream(instance, stream);
                        await this.options.onSubscribeError(instance, new Error("Subscription was cancelled."));
                        this.#schedule(instance);
                        return;
                    case "connection.closed":
                        this.#closeStream(instance, stream);
                        this.options.onConnectionClosed(instance);
                        return;
                }
            } catch (error) {
                if (!this.#desired.has(instance) || this.#tokens.get(instance) !== token) return;
                this.#closeStream(instance, stream);
                await this.options.onSubscribeError(instance, error);
                this.#schedule(instance);
                return;
            }
        }
    }

    #schedule(instance: string): void {
        if (!this.#desired.has(instance) || this.#retries.has(instance)) return;
        const attempt = this.#attempts.get(instance) ?? 0;
        this.#attempts.set(instance, attempt + 1);
        const base = Math.min(this.#retryBaseMs * 2 ** attempt, 30_000);
        const jitter = Math.floor(base * 0.2 * this.#random());
        const timeout = setTimeout(() => {
            this.#retries.delete(instance);
            const next = this.options.currentSequence?.(instance) ?? this.#desired.get(instance);
            if (next !== undefined) void this.#start(instance, Math.max(1, next));
        }, base + jitter);
        this.#retries.set(instance, timeout);
    }

    #armStableReset(instance: string, stream: TuiControlRuntimeStream): void {
        this.#clearStableTimer(instance);
        const timeout = setTimeout(() => {
            this.#stableTimers.delete(instance);
            if (this.#subscriptions.get(instance) === stream) {
                this.#attempts.delete(instance);
                this.#gapStreaks.delete(instance);
            }
        }, this.#stableAfterMs);
        this.#stableTimers.set(instance, timeout);
    }

    #markStable(instance: string): void {
        this.#attempts.delete(instance);
        this.#gapStreaks.delete(instance);
        this.#clearStableTimer(instance);
    }

    #safeClose(stream: TuiControlRuntimeStream): void {
        try {
            stream.close();
        } catch {
            // Late or obsolete subscription cleanup must not suppress recovery.
        }
    }

    #closeStream(instance: string, expected?: TuiControlRuntimeStream): void {
        const stream = this.#subscriptions.get(instance);
        if (stream === undefined || (expected !== undefined && stream !== expected)) return;
        this.#subscriptions.delete(instance);
        this.#clearStableTimer(instance);
        this.#safeClose(stream);
    }

    #clearRetry(instance: string): void {
        const timeout = this.#retries.get(instance);
        if (timeout !== undefined) clearTimeout(timeout);
        this.#retries.delete(instance);
    }

    #clearStableTimer(instance: string): void {
        const timeout = this.#stableTimers.get(instance);
        if (timeout !== undefined) clearTimeout(timeout);
        this.#stableTimers.delete(instance);
    }
}
