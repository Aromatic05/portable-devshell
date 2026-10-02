// Domain-blind event stream primitives over the generic message transport. The
// reader turns a raw MessageStream into ordered seed/event/gap/closed messages
// and drains the initial server seed before yielding live events. Event
// decoding and gap recognition are supplied by the caller, so this knows only
// sequence/cursor semantics. Parsing is deferred to next() so a malformed frame
// surfaces as a stream error instead of throwing inside the data listener.

import type { MessageStream } from "../packet/Stream.js";
import type { JsonValue } from "../primitive/JsonValue.js";

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
                ...events.map(
                    (event): EventStreamEnvelope => ({
                        name: "event",
                        payload: event,
                    }),
                ),
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
        return { event: this.#options.decodeEvent(envelope.payload), kind: "event" };
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
