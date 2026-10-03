// Domain-blind event stream primitives over the generic message transport. The
// reader turns a raw MessageStream into ordered seed/event/gap/closed messages
// and drains the initial server seed before yielding live events. Event
// decoding and gap recognition are supplied by the caller, so this knows only
// sequence/cursor semantics. Parsing is deferred to next() so a malformed frame
// surfaces as a stream error instead of throwing inside the data listener.

import type { MessageStream } from "../transport/packet/Stream.js";
import type { InstanceName } from "../types/Instance.js";
import type { JsonValue } from "../types/Json.js";

export const STREAM_GAP_CODE = "stream.gap";

export interface StreamGap {
    /** Sequence the subscription asked to resume from. */
    fromSeq: number;
    /** Latest sequence the server has produced. */
    lastSeq: number;
    /** Oldest sequence still buffered; resume from here after a refresh. */
    nextSeq: number;
}

export interface EventStreamEnvelope {
    name: string;
    payload?: JsonValue;
    seq?: number;
}

/** Domain-blind instance event record used by storage and stream mechanics. */
export interface InstanceEventRecord<Type extends string = string> {
    at: string;
    data?: JsonValue;
    instanceName: InstanceName;
    seq: number;
    type: Type;
}

export type StreamMessage<Event> =
    | { kind: "event"; event: Event }
    | { details?: JsonValue; gap: StreamGap; kind: "gap" }
    | { error?: Error; kind: "closed" };

export interface EventStreamPort<Event> {
    close(): void;
    next(): Promise<StreamMessage<Event>>;
}

export interface EventStreamOptions<Event> {
    /** Decodes one live event payload; throwing surfaces a stream error. */
    decodeEvent(payload: JsonValue | undefined): Event;
    /** Reads a gap descriptor from a gap payload; undefined to ignore it. */
    readGap(payload: JsonValue | undefined): StreamGap | undefined;
}

export class EventStreamReader<Event> implements EventStreamPort<Event> {
    readonly #stream: MessageStream;
    readonly #options: EventStreamOptions<Event>;
    readonly #queue: EventStreamEnvelope[] = [];
    readonly #waiters: Array<
        (message: EventStreamEnvelope | undefined) => void
    > = [];
    #error?: Error;
    #closed = false;

    constructor(stream: MessageStream, options: EventStreamOptions<Event>) {
        this.#stream = stream;
        this.#options = options;
        stream.onData((message) => this.#push(message as EventStreamEnvelope));
        stream.onClose(() => this.#finish());
        stream.onCancel((error) => {
            this.#error = error === undefined ? undefined : streamError(error);
            this.#finish();
        });
    }

    async next(): Promise<StreamMessage<Event>> {
        const envelope = await this.#nextEnvelope();
        if (envelope === undefined)
            return {
                ...(this.#error === undefined ? {} : { error: this.#error }),
                kind: "closed",
            };
        if (envelope.name === "seed") {
            const payload = record(envelope.payload);
            const events = Array.isArray(payload?.events) ? payload.events : [];
            this.#queue.unshift(
                ...events.map((event): EventStreamEnvelope => ({
                    name: "event",
                    payload: event,
                })),
            );
            return await this.next();
        }
        if (envelope.name === "gap") {
            const gap = this.#options.readGap(envelope.payload);
            if (gap === undefined) return await this.next();
            return {
                ...(envelope.payload === undefined
                    ? {}
                    : { details: envelope.payload }),
                gap,
                kind: "gap",
            };
        }
        return {
            event: this.#options.decodeEvent(envelope.payload),
            kind: "event",
        };
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        void this.#stream.close();
        this.#finish();
    }

    #push(message: EventStreamEnvelope): void {
        const waiter = this.#waiters.shift();
        if (waiter !== undefined) waiter(message);
        else this.#queue.push(message);
    }

    #finish(): void {
        this.#closed = true;
        for (const waiter of this.#waiters.splice(0)) waiter(undefined);
    }

    async #nextEnvelope(): Promise<EventStreamEnvelope | undefined> {
        const message = this.#queue.shift();
        if (message !== undefined) return message;
        if (this.#closed) return undefined;
        return await new Promise((resolve) => this.#waiters.push(resolve));
    }
}

export function readStreamGap(error: unknown): StreamGap | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const candidate = error as { code?: unknown; details?: unknown };
    if (candidate.code !== STREAM_GAP_CODE) return undefined;
    return readStreamGapPayload(candidate.details as JsonValue | undefined);
}

export function readStreamGapPayload(
    payload: JsonValue | undefined,
): StreamGap | undefined {
    const value = record(payload);
    const fromSeq = readNumber(value, "requestedFromSeq");
    const lastSeq = readNumber(value, "latestSeq");
    const nextSeq = readNumber(value, "oldestAvailableSeq");
    if (fromSeq === undefined || lastSeq === undefined || nextSeq === undefined)
        return undefined;
    return { fromSeq, lastSeq, nextSeq };
}

function streamError(error: {
    code?: string;
    details?: unknown;
    message: string;
    retryable?: boolean;
}): Error {
    return Object.assign(new Error(error.message), {
        ...(error.code === undefined ? {} : { code: error.code }),
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(error.retryable === undefined
            ? {}
            : { retryable: error.retryable }),
    });
}

function record(value: unknown): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, JsonValue>)
        : undefined;
}

function readNumber(
    value: Record<string, JsonValue> | undefined,
    key: string,
): number | undefined {
    return typeof value?.[key] === "number" ? value[key] : undefined;
}
// Domain-blind connect/retry/backoff engine for a cursor-resumable event
// stream. It owns opening, cursor advancement, gap-recovery scheduling, and
// reconnection. The owning ViewModel supplies domain recovery policy through
// onGap (return the cursor to resume from after it has refreshed its
// authoritative snapshot) and projects its own status.

export type SubscriptionStatus =
    "connecting" | "live" | "reconnecting" | "stopped";

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
            this.#setStatus(
                this.#attempt === 0 ? "connecting" : "reconnecting",
            );
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
                    if (!this.#active || recovered === undefined)
                        return "retry";
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

export type InstanceEventStreamPort<
    Event extends InstanceEventRecord = InstanceEventRecord,
> = EventStreamPort<Event>;

export class InstanceEventStream<
    Event extends InstanceEventRecord = InstanceEventRecord,
> extends EventStreamReader<Event> {
    constructor(instance: InstanceName, stream: MessageStream) {
        super(stream, {
            decodeEvent: (payload) => {
                const event = readInstanceEventRecord(payload);
                if (event.instanceName !== instance)
                    throw new Error("Subscription contains another instance.");
                return event as Event;
            },
            readGap: readStreamGapPayload,
        });
    }
}

export type InstanceEventSubscriptionStatus = SubscriptionStatus;

export interface InstanceEventSubscriptionOptions<
    Event extends InstanceEventRecord = InstanceEventRecord,
> {
    onEvent(event: Event): void;
    onGap(gap: StreamGap): Promise<number | undefined> | number | undefined;
    onStatusChange?(status: InstanceEventSubscriptionStatus): void;
    open(fromSeq: number): Promise<InstanceEventStreamPort<Event>>;
    retryBaseMs?: number;
    retryMaxMs?: number;
}

export class InstanceEventSubscription<
    Event extends InstanceEventRecord = InstanceEventRecord,
> extends EventSubscription<Event> {
    constructor(
        fromSeq: number,
        options: InstanceEventSubscriptionOptions<Event>,
    ) {
        super(fromSeq, {
            ...options,
            eventSeq: (event) => event.seq,
            readGapError: readStreamGap,
        });
    }
}

function readInstanceEventRecord(
    value: JsonValue | undefined,
): InstanceEventRecord {
    const event = record(value);
    if (
        event === undefined ||
        typeof event.at !== "string" ||
        typeof event.instanceName !== "string" ||
        typeof event.seq !== "number" ||
        typeof event.type !== "string"
    )
        throw new Error("Invalid instance event.");
    return {
        at: event.at,
        ...(event.data === undefined ? {} : { data: event.data }),
        instanceName: event.instanceName as InstanceName,
        seq: event.seq,
        type: event.type,
    };
}
