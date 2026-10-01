import { Connection, Port } from "../endpoint/route/Route.js";
import type { Address } from "../envelope/Codec.js";
import type { Message } from "./Packet.js";

export interface EventPacket {
    readonly protocol: "event";
    readonly name: string;
    readonly message?: Message;
}

export class Event {
    readonly #connection?: Connection;
    readonly #listeners = new Set<
        (name: string, message: Message | undefined, peer: Address) =>
            Promise<void> | void
    >();
    readonly #unsubscribe: () => void;

    constructor(target: Connection | Port) {
        if (target instanceof Connection) {
            this.#connection = target;
            this.#unsubscribe = target.onPacket((packet) =>
                this.#accept(packet, target.remote),
            );
        } else {
            this.#unsubscribe = target.onPacket((packet, peer) =>
                this.#accept(packet, peer),
            );
        }
    }

    send(name: string, message?: Message): Promise<void> {
        if (this.#connection === undefined)
            throw new Error("Event send requires a Connection.");
        return this.#connection.send({
            protocol: "event",
            name,
            ...(message === undefined ? {} : { message }),
        } satisfies EventPacket);
    }

    onEvent(
        listener: (
            name: string,
            message: Message | undefined,
            peer: Address,
        ) => Promise<void> | void,
    ): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    close(): void {
        this.#unsubscribe();
        this.#listeners.clear();
    }

    async #accept(value: unknown, peer: Address): Promise<void> {
        if (typeof value !== "object" || value === null) return;
        const packet = value as Partial<EventPacket>;
        if (packet.protocol !== "event") return;
        if (typeof packet.name !== "string") throw new Error("Invalid Event packet.");
        for (const listener of this.#listeners)
            await listener(packet.name, packet.message, peer);
    }
}
