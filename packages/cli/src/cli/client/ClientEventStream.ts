import {
    asInstanceName,
    createError,
    errorCodes,
    readClientSubscriptionEvents,
    type Event,
    type JsonValue,
    type OpenedClientStream,
    type PrefixRoute
} from "@portable-devshell/shared";

export class ClientEventStream {
    readonly #route: PrefixRoute;
    readonly #initialEvents: Event[];

    constructor(route: PrefixRoute, initialEvents: Event[]) {
        this.#route = route;
        this.#initialEvents = [...initialEvents];
    }

    async nextEvent(): Promise<Event> {
        const initial = this.#initialEvents.shift();
        if (initial !== undefined) {
            return initial;
        }
        const event = (await this.#route.nextStreamFrame()).event;
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
        this.#route.close();
    }
}

export function clientEventStream(instance: string, opened: OpenedClientStream): ClientEventStream {
    const destination = asInstanceName(instance);
    return new ClientEventStream(
        opened.route,
        readClientSubscriptionEvents(destination, opened.acknowledgement.event.payload)
    );
}
