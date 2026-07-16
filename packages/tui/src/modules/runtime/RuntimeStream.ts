import {
    asInstanceName,
    readClientSubscriptionEvents,
    type ClientEvent,
    type ClientStream,
    type OpenedClientStream
} from "@portable-devshell/shared";

export type RuntimeStreamMessage =
    | { event: ClientEvent; kind: "instance.event" }
    | { event: ClientEvent; kind: "stream.gap" }
    | { event: ClientEvent; kind: "stream.cancelled" }
    | { kind: "connection.closed" };

export class RuntimeStream {
    readonly #stream: ClientStream;
    readonly #initialEvents: ClientEvent[];
    #closed = false;

    constructor(stream: ClientStream, initialEvents: ClientEvent[]) {
        this.#stream = stream;
        this.#initialEvents = [...initialEvents];
    }

    async nextMessage(): Promise<RuntimeStreamMessage> {
        const initial = this.#initialEvents.shift();
        if (initial !== undefined) {
            return { event: initial, kind: "instance.event" };
        }
        if (this.#closed) {
            return { kind: "connection.closed" };
        }
        try {
            const event = await this.#stream.nextEvent();
            if (event.name === "stream.gap") {
                return { event, kind: "stream.gap" };
            }
            if (event.name === "stream.cancelled" || event.name === "stream.completed") {
                return { event, kind: "stream.cancelled" };
            }
            return { event, kind: "instance.event" };
        } catch {
            return { kind: "connection.closed" };
        }
    }

    close(): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#stream.close();
    }
}

export function runtimeStream(instance: string, opened: OpenedClientStream): RuntimeStream {
    return new RuntimeStream(
        opened.stream,
        readClientSubscriptionEvents(asInstanceName(instance), opened.acknowledgement.payload)
    );
}
