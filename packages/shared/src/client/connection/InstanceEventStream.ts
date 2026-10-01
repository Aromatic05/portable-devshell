import type { ControlErrorBody } from "../../protocol/Error.js";
import type { InstanceEvent } from "../../protocol/instance/activity/Event.js";
import type { JsonValue } from "../../protocol/JsonValue.js";
import type { InstanceName } from "../../protocol/instance/Identity.js";
import type { ControlStreamMessage } from "../../protocol/control/Port.js";
import type { MessageStream, StreamError } from "../../transport/packet/Stream.js";
import { asInstanceName } from "../../protocol/instance/Identity.js";

export type InstanceStreamMessage =
    | { event: InstanceEvent; kind: "event" }
    | {
          details?: JsonValue;
          error?: ControlErrorBody;
          fromSeq?: number;
          kind: "gap";
          lastSeq?: number;
          nextSeq?: number;
      }
    | { error?: Error; kind: "closed" };

export interface InstanceEventStreamPort {
    close(): void;
    next(): Promise<InstanceStreamMessage>;
}

export class InstanceEventStream implements InstanceEventStreamPort {
    readonly #instance: InstanceName;
    readonly #stream: MessageStream;
    readonly #queue: ControlStreamMessage[] = [];
    readonly #waiters: Array<(message: ControlStreamMessage | undefined) => void> = [];
    #error?: StreamError;
    #closed = false;

    constructor(instance: InstanceName, stream: MessageStream) {
        this.#instance = instance;
        this.#stream = stream;
        stream.onData((message) => this.#push(message as ControlStreamMessage));
        stream.onClose(() => this.#finish());
        stream.onCancel((error) => {
            this.#error = error;
            this.#finish();
        });
    }

    async next(): Promise<InstanceStreamMessage> {
        const message = await this.#nextMessage();
        if (message === undefined)
            return {
                ...(this.#error === undefined
                    ? {}
                    : { error: Object.assign(new Error(this.#error.message), this.#error) }),
                kind: "closed",
            };
        if (message.name === "seed") {
            const value = record(message.payload);
            const events = Array.isArray(value?.events) ? value.events : [];
            for (const event of events.reverse())
                this.#queue.unshift({ name: "event", payload: event });
            return await this.next();
        }
        if (message.name === "gap") {
            const value = record(message.payload);
            return {
                ...(message.payload === undefined ? {} : { details: message.payload }),
                ...(readNumber(value, "requestedFromSeq") === undefined
                    ? {}
                    : { fromSeq: readNumber(value, "requestedFromSeq") }),
                kind: "gap",
                ...(readNumber(value, "latestSeq") === undefined
                    ? {}
                    : { lastSeq: readNumber(value, "latestSeq") }),
                ...(readNumber(value, "oldestAvailableSeq") === undefined
                    ? {}
                    : { nextSeq: readNumber(value, "oldestAvailableSeq") }),
            };
        }
        const event = readInstanceEvent(message.payload);
        if (event.instanceName !== this.#instance)
            throw new Error("Subscription contains another instance.");
        return { event, kind: "event" };
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        void this.#stream.close();
        this.#finish();
    }

    #push(message: ControlStreamMessage): void {
        const waiter = this.#waiters.shift();
        if (waiter !== undefined) waiter(message);
        else this.#queue.push(message);
    }

    #finish(): void {
        this.#closed = true;
        for (const waiter of this.#waiters.splice(0)) waiter(undefined);
    }

    async #nextMessage(): Promise<ControlStreamMessage | undefined> {
        const message = this.#queue.shift();
        if (message !== undefined) return message;
        if (this.#closed) return undefined;
        return await new Promise((resolve) => this.#waiters.push(resolve));
    }
}

export function readInstanceEvent(value: JsonValue | undefined): InstanceEvent {
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
        instanceName: asInstanceName(event.instanceName),
        seq: event.seq,
        type: event.type as InstanceEvent["type"],
    };
}

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}

function readNumber(
    value: Record<string, JsonValue> | undefined,
    key: string,
): number | undefined {
    return typeof value?.[key] === "number" ? value[key] : undefined;
}
