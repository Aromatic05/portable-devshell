// Domain-blind connect/retry/backoff engine for a cursor-resumable event
// stream. It owns opening, cursor advancement, gap-recovery scheduling, and
// reconnection. The owning ViewModel supplies domain recovery policy through
// onGap (return the cursor to resume from after it has refreshed its
// authoritative snapshot) and projects its own status.

import type { EventStreamPort, StreamGap } from "./EventStream.js";

export type SubscriptionStatus =
    | "connecting"
    | "live"
    | "reconnecting"
    | "stopped";

export interface EventSubscriptionOptions<Event> {
    onEvent(event: Event): void;
    /**
     * Recover from a gap and return the sequence to resume from. Return
     * undefined to let the subscription retry with backoff.
     */
    onGap(gap: StreamGap): Promise<number | undefined> | number | undefined;
    onStatusChange?(status: SubscriptionStatus): void;
    open(fromSeq: number): Promise<EventStreamPort<Event>>;
    /** Reads the sequence carried by an event, used to advance the cursor. */
    eventSeq(event: Event): number;
    /** Recognizes a gap error thrown by open; undefined means retry. */
    readGapError(error: unknown): StreamGap | undefined;
    retryBaseMs?: number;
    retryMaxMs?: number;
}

export class EventSubscription<Event> {
    readonly #options: EventSubscriptionOptions<Event>;
    readonly #retryBaseMs: number;
    readonly #retryMaxMs: number;
    #active = false;
    #attempt = 0;
    #cursor: number;
    #retryTimer?: ReturnType<typeof setTimeout>;
    #status: SubscriptionStatus = "stopped";
    #stream?: EventStreamPort<Event>;

    constructor(fromSeq: number, options: EventSubscriptionOptions<Event>) {
        this.#cursor = Math.max(1, fromSeq);
        this.#options = options;
        this.#retryBaseMs = options.retryBaseMs ?? 500;
        this.#retryMaxMs = options.retryMaxMs ?? 15_000;
    }

    get cursor(): number {
        return this.#cursor;
    }

    get status(): SubscriptionStatus {
        return this.#status;
    }

    start(): void {
        if (this.#active) return;
        this.#active = true;
        void this.#run();
    }

    stop(): void {
        if (!this.#active) return;
        this.#active = false;
        if (this.#retryTimer !== undefined) {
            clearTimeout(this.#retryTimer);
            this.#retryTimer = undefined;
        }
        const stream = this.#stream;
        this.#stream = undefined;
        stream?.close();
        this.#setStatus("stopped");
    }

    async #run(): Promise<void> {
        while (this.#active) {
            this.#setStatus(this.#attempt === 0 ? "connecting" : "reconnecting");
            let stream: EventStreamPort<Event>;
            try {
                stream = await this.#options.open(this.#cursor);
            } catch (error) {
                const gap = this.#options.readGapError(error);
                if (gap !== undefined && this.#active) {
                    const recovered = await this.#recover(gap);
                    if (recovered !== undefined) {
                        this.#cursor = recovered;
                        continue;
                    }
                }
                if (!this.#active) return;
                this.#scheduleRetry();
                return;
            }
            if (!this.#active) {
                stream.close();
                return;
            }
            this.#stream = stream;
            this.#attempt = 0;
            this.#setStatus("live");
            const outcome = await this.#consume(stream);
            this.#stream = undefined;
            stream.close();
            if (!this.#active) return;
            if (outcome === "reopen") continue;
            this.#scheduleRetry();
            return;
        }
    }

    async #consume(
        stream: EventStreamPort<Event>,
    ): Promise<"reopen" | "retry"> {
        try {
            while (this.#active) {
                const message = await stream.next();
                if (!this.#active) return "retry";
                if (message.kind === "event") {
                    this.#cursor = Math.max(
                        this.#cursor,
                        this.#options.eventSeq(message.event) + 1,
                    );
                    this.#options.onEvent(message.event);
                    continue;
                }
                if (message.kind === "gap") {
                    const recovered = await this.#recover(message.gap);
                    if (!this.#active || recovered === undefined) return "retry";
                    this.#cursor = recovered;
                    return "reopen";
                }
                return "retry";
            }
            return "retry";
        } catch {
            return "retry";
        }
    }

    async #recover(gap: StreamGap): Promise<number | undefined> {
        this.#setStatus("reconnecting");
        try {
            return await this.#options.onGap(gap);
        } catch {
            return undefined;
        }
    }

    #scheduleRetry(): void {
        if (!this.#active || this.#retryTimer !== undefined) return;
        const delay = Math.min(
            this.#retryBaseMs * 2 ** this.#attempt,
            this.#retryMaxMs,
        );
        this.#attempt += 1;
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = undefined;
            if (this.#active) void this.#run();
        }, delay);
    }

    #setStatus(status: SubscriptionStatus): void {
        if (this.#status === status) return;
        this.#status = status;
        this.#options.onStatusChange?.(status);
    }
}
