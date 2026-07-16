import {
    asInstanceName,
    readClientSubscriptionEvents,
    type Event,
    type OpenedClientStream,
    type PrefixRoute
} from "@portable-devshell/shared";

export type RuntimeStreamMessage =
    | { event: Event; kind: "instance.event" }
    | { event: Event; kind: "stream.gap" }
    | { event: Event; kind: "stream.cancelled" }
    | { kind: "connection.closed" };

export class RuntimeStream {
    readonly #route: PrefixRoute;
    readonly #initialEvents: Event[];
    #closed = false;

    constructor(route: PrefixRoute, initialEvents: Event[]) {
        this.#route = route;
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
            const event = (await this.#route.nextStreamFrame()).event;
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
        this.#route.close();
    }
}

export function runtimeStream(instance: string, opened: OpenedClientStream): RuntimeStream {
    const destination = asInstanceName(instance);
    return new RuntimeStream(
        opened.route,
        readClientSubscriptionEvents(destination, opened.acknowledgement.event.payload)
    );
}
