import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

import type { TuiControlConnection } from "./TuiControlConnection.js";
import type {
    TuiControlEventEnvelope,
    TuiControlStreamCancelledEnvelope,
    TuiControlStreamGapEnvelope
} from "./TuiControlRequest.js";

export type TuiControlStreamMessage =
    | {
          envelope: TuiControlEventEnvelope;
          kind: "instance.event";
      }
    | {
          envelope: TuiControlStreamGapEnvelope;
          kind: "stream.gap";
      }
    | {
          envelope: TuiControlStreamCancelledEnvelope;
          kind: "stream.cancelled";
      }
    | {
          kind: "connection.closed";
      };

export class TuiControlStream {
    readonly #connection: TuiControlConnection;
    readonly #initialMessages: TuiControlStreamMessage[];
    #closed = false;

    constructor(connection: TuiControlConnection, initialEvents: TuiControlEventEnvelope[]) {
        this.#connection = connection;
        this.#initialMessages = initialEvents.map((event) => toStreamMessage(event));
    }

    async nextMessage(): Promise<TuiControlStreamMessage> {
        if (this.#closed) {
            return {
                kind: "stream.cancelled",
                envelope: {
                    event: "stream.cancelled",
                    payload: {
                        instance: "",
                        reason: "client.closed"
                    },
                    seq: 0,
                    target: {
                        instance: "",
                        kind: "instance"
                    },
                    type: "event"
                }
            };
        }

        const event = this.#initialMessages.shift();

        if (event !== undefined) {
            return event;
        }

        return await this.#connection.nextStreamMessage();
    }

    close(): void {
        this.#closed = true;
        this.#connection.close();
    }
}

export function toStreamMessage(event: TuiControlEventEnvelope): TuiControlStreamMessage {
    if (event.event === "stream.gap") {
        return {
            envelope: event as TuiControlStreamGapEnvelope,
            kind: "stream.gap"
        };
    }

    if (event.event === "stream.cancelled") {
        return {
            envelope: event as TuiControlStreamCancelledEnvelope,
            kind: "stream.cancelled"
        };
    }

    return {
        envelope: event,
        kind: "instance.event"
    };
}

export function asStreamGapError(message: TuiControlStreamGapEnvelope): Error {
    return createError({
        code: errorCodes.streamGap,
        message: "Requested event sequence is no longer available. Pull a fresh snapshot.",
        retryable: true,
        details: message.payload as unknown as JsonValue
    });
}
