import {
    asInstanceName,
    createError,
    errorCodes,
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
    return new ClientEventStream(opened.route, readInitialEvents(destination, opened.acknowledgement.event.payload));
}

function readInitialEvents(destination: ReturnType<typeof asInstanceName>, payload: JsonValue | undefined): Event[] {
    if (!isRecord(payload) || !Array.isArray(payload.events)) {
        throw new Error("Invalid subscription acknowledgement.");
    }
    return payload.events.map((value) => {
        if (!isRecord(value) || typeof value.type !== "string" || typeof value.seq !== "number") {
            throw new Error("Invalid initial subscription event.");
        }
        return {
            destination,
            name: value.type as Event["name"],
            payload: value as JsonValue,
            seq: value.seq
        };
    });
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
