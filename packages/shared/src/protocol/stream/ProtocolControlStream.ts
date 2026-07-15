import { asInstanceName } from "../../type/identity/TypeIdentityInstanceName.js";
import type {
    ControlEventEnvelope,
    ControlStreamCancelledEnvelope,
    ControlStreamGapEnvelope
} from "../envelope/ProtocolEnvelopeControl.js";

export type ProtocolControlStreamMessage =
    | { envelope: ControlEventEnvelope; kind: "instance.event" }
    | { envelope: ControlStreamGapEnvelope; kind: "stream.gap" }
    | { envelope: ControlStreamCancelledEnvelope; kind: "stream.cancelled" }
    | { kind: "connection.closed" };

export interface ProtocolControlStreamConnection {
    close(): void;
    nextStreamMessage(): Promise<ProtocolControlStreamMessage>;
}

export class ProtocolControlStream {
    readonly #connection: ProtocolControlStreamConnection;
    readonly #initialMessages: ProtocolControlStreamMessage[];
    #closed = false;

    constructor(connection: ProtocolControlStreamConnection, initialEvents: ControlEventEnvelope[]) {
        this.#connection = connection;
        this.#initialMessages = initialEvents.map(toControlStreamMessage);
    }

    async nextMessage(): Promise<ProtocolControlStreamMessage> {
        if (this.#closed) {
            return {
                envelope: {
                    event: "stream.cancelled",
                    payload: { instance: "", reason: "client.closed" },
                    seq: 0,
                    target: { instance: asInstanceName(""), kind: "instance" },
                    type: "event"
                },
                kind: "stream.cancelled"
            };
        }
        return this.#initialMessages.shift() ?? await this.#connection.nextStreamMessage();
    }

    close(): void {
        this.#closed = true;
        this.#connection.close();
    }
}

export function toControlStreamMessage(event: ControlEventEnvelope): ProtocolControlStreamMessage {
    if (event.event === "stream.gap") {
        return { envelope: event as ControlStreamGapEnvelope, kind: "stream.gap" };
    }
    if (event.event === "stream.cancelled") {
        return { envelope: event as ControlStreamCancelledEnvelope, kind: "stream.cancelled" };
    }
    return { envelope: event, kind: "instance.event" };
}
