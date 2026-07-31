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

export class InstanceStreamSupervisor {
    #streams = new Map<string, WebRuntimeStream>();
    #retries = new Map<string, ReturnType<typeof setTimeout>>();
    #attempts = new Map<string, number>();

    constructor(
        private readonly clients: WebClients,
        private readonly callbacks: InstanceStreamCallbacks,
        private readonly retryBaseMs = 1_000,
    ) {}

    async start(name: string, fromSeq: number, generation: number): Promise<void> {
        if (!this.callbacks.isCurrent(generation)) return;
        this.clearRetry(name);
        this.#streams.get(name)?.close();
        this.#streams.delete(name);
        try {
            const stream = await this.clients.runtime.subscribe(name, fromSeq);
            if (!this.callbacks.isCurrent(generation)) {
                stream.close();
                return;
            }
            this.#streams.set(name, stream);
            this.#attempts.delete(name);
            this.callbacks.onRecovered(name);
            void this.consume(name, stream, generation);
        } catch (error) {
            if (!this.callbacks.isCurrent(generation)) return;
            this.callbacks.onFailure(name, error);
            this.schedule(name, generation);
        }
    }

    closeAll(): void {
        for (const stream of this.#streams.values()) stream.close();
        this.#streams.clear();
        for (const timeout of this.#retries.values()) clearTimeout(timeout);
        this.#retries.clear();
        this.#attempts.clear();
    }

    private async consume(
        name: string,
        stream: WebRuntimeStream,
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
                    const lastSeq = await this.callbacks.onGap(name, generation);
                    if (this.callbacks.isCurrent(generation)) {
                        await this.start(name, lastSeq, generation);
                    }
                    return;
                }
                if (event.kind === "closed") {
                    this.#streams.delete(name);
                    this.callbacks.onFailure(name, "Subscription closed.");
                    this.schedule(name, generation);
                    return;
                }
                this.callbacks.onEvent(name, event.event, generation);
            } catch (error) {
                if (!this.callbacks.isCurrent(generation)) return;
                this.#streams.delete(name);
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
        const delay = Math.min(this.retryBaseMs * 2 ** attempt, 30_000);
        const timeout = setTimeout(() => {
            this.#retries.delete(name);
            void this.start(
                name,
                this.callbacks.currentSequence(name),
                generation,
            );
        }, delay);
        this.#retries.set(name, timeout);
    }

    private clearRetry(name: string): void {
        const timeout = this.#retries.get(name);
        if (timeout !== undefined) clearTimeout(timeout);
        this.#retries.delete(name);
    }
}
