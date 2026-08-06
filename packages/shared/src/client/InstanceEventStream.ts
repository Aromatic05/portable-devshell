import type { ControlErrorBody } from "../error/ErrorBodyControl.js";
import { createError } from "../error/ErrorFactoryCreate.js";
import type { InstanceEvent } from "../dto/instance/DtoInstanceEvent.js";
import type { JsonValue } from "../type/TypeJsonValue.js";
import { asInstanceName, type InstanceName } from "../type/identity/TypeIdentityInstanceName.js";
import type {
    ClientEvent,
    ClientStream,
    OpenedClientStream,
} from "../transport/ClientConnection.js";

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
    readonly #initial: InstanceEvent[];
    readonly #stream: ClientStream;
    #closed = false;

    constructor(instance: InstanceName, opened: OpenedClientStream) {
        this.#stream = opened.stream;
        this.#initial = readInitialEvents(instance, opened.acknowledgement.payload);
    }

    async next(): Promise<InstanceStreamMessage> {
        const initial = this.#initial.shift();
        if (initial !== undefined) {
            return { event: initial, kind: "event" };
        }
        if (this.#closed) {
            return { kind: "closed" };
        }
        let event: ClientEvent;
        try {
            event = await this.#stream.nextEvent();
        } catch (error) {
            this.#closed = true;
            return {
                error: error instanceof Error ? error : new Error(String(error)),
                kind: "closed",
            };
        }
        if (event.name === "stream.gap") {
            const value = record(event.payload);
            return {
                ...(event.payload === undefined ? {} : { details: event.payload }),
                ...(event.error === undefined ? {} : { error: event.error }),
                ...(readNumber(value, "requestedFromSeq", "fromSeq") === undefined
                    ? {}
                    : {
                          fromSeq: readNumber(
                              value,
                              "requestedFromSeq",
                              "fromSeq",
                          ),
                      }),
                kind: "gap",
                ...(readNumber(value, "latestSeq", "lastSeq") === undefined
                    ? {}
                    : {
                          lastSeq: readNumber(value, "latestSeq", "lastSeq"),
                      }),
                ...(readNumber(
                    value,
                    "oldestAvailableSeq",
                    "nextSeq",
                ) === undefined
                    ? {}
                    : {
                          nextSeq: readNumber(
                              value,
                              "oldestAvailableSeq",
                              "nextSeq",
                          ),
                      }),
            };
        }
        if (event.name === "stream.completed" || event.name === "stream.cancelled") {
            this.#closed = true;
            return {
                ...(event.error === undefined
                    ? {}
                    : { error: createError(event.error) }),
                kind: "closed",
            };
        }
        return { event: readInstanceEvent(event.payload), kind: "event" };
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#stream.close();
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
    ) {
        throw new Error("Invalid instance event.");
    }
    return {
        at: event.at,
        ...(event.data === undefined ? {} : { data: event.data }),
        instanceName: asInstanceName(event.instanceName),
        seq: event.seq,
        type: event.type as InstanceEvent["type"],
    };
}

export function readClientSubscriptionEvents(
    destination: InstanceName,
    payload: JsonValue | undefined,
): ClientEvent[] {
    return readInitialEvents(destination, payload).map((event) => ({
        destination,
        id: `initial-${event.seq}`,
        name: event.type,
        payload: event as unknown as JsonValue,
        seq: event.seq,
    }));
}

export function normalizeInstanceClientEvent(event: ClientEvent): ClientEvent {
    if (event.name !== "instanceEvent.published") return event;
    const published = readInstanceEvent(event.payload);
    return {
        ...event,
        destination: published.instanceName,
        name: published.type,
        payload: published as unknown as JsonValue,
        seq: published.seq,
    };
}

function readInitialEvents(
    instance: InstanceName,
    value: JsonValue | undefined,
): InstanceEvent[] {
    const acknowledgement = record(value);
    if (acknowledgement === undefined || !Array.isArray(acknowledgement.events)) {
        throw new Error("Invalid subscription acknowledgement.");
    }
    return acknowledgement.events.map((event) => {
        const decoded = readInstanceEvent(event);
        if (decoded.instanceName !== instance) {
            throw new Error("Subscription acknowledgement contains another instance.");
        }
        return decoded;
    });
}

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}

function readNumber(
    value: Record<string, JsonValue> | undefined,
    primary: string,
    fallback: string,
): number | undefined {
    const candidate = value?.[primary] ?? value?.[fallback];
    return typeof candidate === "number" ? candidate : undefined;
}
