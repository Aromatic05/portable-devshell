import {
    asInstanceName,
    createError,
    errorCodes,
    readClientSubscriptionEvents,
    type ClientEvent,
    type ClientStream,
    type JsonValue,
    type OpenedClientStream
} from "@portable-devshell/shared";

export class ClientEventStream {
    readonly #stream: ClientStream;
    readonly #initialEvents: ClientEvent[];

    constructor(stream: ClientStream, initialEvents: ClientEvent[]) {
        this.#stream = stream;
        this.#initialEvents = [...initialEvents];
    }

    async nextEvent(): Promise<ClientEvent> {
        const initial = this.#initialEvents.shift();
        if (initial !== undefined) {
            return initial;
        }
        const event = await this.#stream.nextEvent();
        if (event.name === "stream.gap") {
            throw createError({
                code: errorCodes.streamGap,
                message: "Requested event sequence is no longer available. Pull a fresh snapshot.",
                retryable: true,
                details: event.payload as JsonValue
            });
        }
        if (event.name === "stream.cancelled") {
            if (event.error !== undefined) {
                throw createError(event.error);
            }
            throw new Error("control stream was cancelled");
        }
        if (event.name === "stream.completed") {
            throw new Error("control stream completed");
        }
        return event;
    }

    close(): void {
        this.#stream.close();
    }
}

export function clientEventStream(instance: string, opened: OpenedClientStream): ClientEventStream {
    return new ClientEventStream(
        opened.stream,
        readClientSubscriptionEvents(asInstanceName(instance), opened.acknowledgement.payload)
    );
}
