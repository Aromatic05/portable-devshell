import type { InstanceEvent } from "@portable-devshell/shared/browser";

import type { WebClients, WebRuntimeStream } from "../client/WebClients.js";

export interface InstanceStreamCallbacks {
    currentSequence(name: string): number;
    isCurrent(generation: number): boolean;
    onEvent(name: string, event: InstanceEvent, generation: number): void;
    onFailure(name: string, error: unknown): void;
    onGap(name: string, generation: number): Promise<number>;
    onRecovered(name: string): void;
}

export interface InstanceStreamSupervisorOptions {
    random?: () => number;
    retryBaseMs?: number;
    stableAfterMs?: number;
}

export class InstanceStreamSupervisor {
    #streams = new Map<string, WebRuntimeStream>();
    #retries = new Map<string, ReturnType<typeof setTimeout>>();
    #stableTimers = new Map<string, ReturnType<typeof setTimeout>>();
    #attempts = new Map<string, number>();
    #gapStreaks = new Map<string, number>();
    #startTokens = new Map<string, number>();
    readonly #random: () => number;
    readonly #retryBaseMs: number;
    readonly #stableAfterMs: number;

    constructor(
        private readonly clients: WebClients,
        private readonly callbacks: InstanceStreamCallbacks,
        options: InstanceStreamSupervisorOptions = {},
    ) {
        this.#random = options.random ?? Math.random;
        this.#retryBaseMs = options.retryBaseMs ?? 1_000;
        this.#stableAfterMs = options.stableAfterMs ?? Math.max(1_000, this.#retryBaseMs * 4);
    }

    async start(name: string, fromSeq: number, generation: number): Promise<void> {
        if (!this.callbacks.isCurrent(generation)) return;
        const token = (this.#startTokens.get(name) ?? 0) + 1;
        this.#startTokens.set(name, token);
        this.clearRetry(name);
        this.closeStream(name);
        try {
            const stream = await this.clients.runtime.subscribe(name, fromSeq);
            if (
                !this.callbacks.isCurrent(generation) ||
                this.#startTokens.get(name) !== token
            ) {
                stream.close();
                return;
            }
            this.#streams.set(name, stream);
            this.callbacks.onRecovered(name);
            this.armStableReset(name, stream);
            void this.consume(name, stream, fromSeq, generation);
        } catch (error) {
            if (
                !this.callbacks.isCurrent(generation) ||
                this.#startTokens.get(name) !== token
            ) return;
            this.callbacks.onFailure(name, error);
            this.schedule(name, generation);
        }
    }

    closeAll(): void {
        for (const name of this.#streams.keys()) this.closeStream(name);
        for (const timeout of this.#retries.values()) clearTimeout(timeout);
        this.#retries.clear();
        for (const timeout of this.#stableTimers.values()) clearTimeout(timeout);
        this.#stableTimers.clear();
        this.#attempts.clear();
        this.#gapStreaks.clear();
        for (const [name, token] of this.#startTokens) {
            this.#startTokens.set(name, token + 1);
        }
    }

    private async consume(
        name: string,
        stream: WebRuntimeStream,
        fromSeq: number,
        generation: number,
    ): Promise<void> {
        while (
            this.callbacks.isCurrent(generation) &&
            this.#streams.get(name) === stream
        ) {
            try {
                const event = await stream.next();
                if (
                    !this.callbacks.isCurrent(generation) ||
                    this.#streams.get(name) !== stream
                ) return;
                if (event.kind === "gap") {
                    this.closeStream(name, stream);
                    try {
                        const lastSeq = await this.callbacks.onGap(name, generation);
                        if (!this.callbacks.isCurrent(generation)) return;
                        if (lastSeq > fromSeq) {
                            const streak = (this.#gapStreaks.get(name) ?? 0) + 1;
                            this.#gapStreaks.set(name, streak);
                            if (streak === 1) {
                                await this.start(name, lastSeq, generation);
                            } else {
                                this.callbacks.onFailure(
                                    name,
                                    `Subscription produced ${streak} consecutive gaps.`,
                                );
                                this.schedule(name, generation);
                            }
                        } else {
                            this.callbacks.onFailure(
                                name,
                                `Subscription gap did not advance beyond sequence ${fromSeq}.`,
                            );
                            this.schedule(name, generation);
                        }
                    } catch (error) {
                        if (!this.callbacks.isCurrent(generation)) return;
                        this.callbacks.onFailure(name, error);
                        this.schedule(name, generation);
                    }
                    return;
                }
                if (event.kind === "closed") {
                    this.closeStream(name, stream);
                    this.callbacks.onFailure(name, "Subscription closed.");
                    this.schedule(name, generation);
                    return;
                }
                this.markStable(name);
                this.callbacks.onEvent(name, event.event, generation);
            } catch (error) {
                if (!this.callbacks.isCurrent(generation)) return;
                this.closeStream(name, stream);
                this.callbacks.onFailure(name, error);
                this.schedule(name, generation);
                return;
            }
        }
    }

    private schedule(name: string, generation: number): void {
        if (
            !this.callbacks.isCurrent(generation) ||
            this.#retries.has(name)
        ) return;
        const attempt = this.#attempts.get(name) ?? 0;
        this.#attempts.set(name, attempt + 1);
        const baseDelay = Math.min(this.#retryBaseMs * 2 ** attempt, 30_000);
        const jitter = Math.floor(baseDelay * 0.2 * this.#random());
        const timeout = setTimeout(() => {
            this.#retries.delete(name);
            void this.start(
                name,
                this.callbacks.currentSequence(name),
                generation,
            );
        }, baseDelay + jitter);
        this.#retries.set(name, timeout);
    }

    private armStableReset(name: string, stream: WebRuntimeStream): void {
        this.clearStableTimer(name);
        const timeout = setTimeout(() => {
            this.#stableTimers.delete(name);
            if (this.#streams.get(name) === stream) {
                this.#attempts.delete(name);
                this.#gapStreaks.delete(name);
            }
        }, this.#stableAfterMs);
        this.#stableTimers.set(name, timeout);
    }

    private markStable(name: string): void {
        this.#attempts.delete(name);
        this.#gapStreaks.delete(name);
        this.clearStableTimer(name);
    }

    private closeStream(name: string, expected?: WebRuntimeStream): void {
        const stream = this.#streams.get(name);
        if (stream === undefined || (expected !== undefined && stream !== expected)) return;
        this.#streams.delete(name);
        this.clearStableTimer(name);
        try {
            stream.close();
        } catch {
            // Cleanup must not suppress recovery.
        }
    }

    private clearRetry(name: string): void {
        const timeout = this.#retries.get(name);
        if (timeout !== undefined) clearTimeout(timeout);
        this.#retries.delete(name);
    }

    private clearStableTimer(name: string): void {
        const timeout = this.#stableTimers.get(name);
        if (timeout !== undefined) clearTimeout(timeout);
        this.#stableTimers.delete(name);
    }
}
