import { EnvelopeCodec } from "../envelope/Codec.js";
import { FrameProtocol } from "../frame/Protocol.js";
import { FrameStreamChannel } from "../frame/Stream.js";
import { createTransportId, type Host, type PortName } from "./Address.js";
import type { Channel } from "./channel/Channel.js";
import { Connection, Port, Route } from "./route/Route.js";

const ENVELOPE_SERVICE = "envelope";

export interface EndpointOptions {
    readonly host?: Host;
    connectChannel?(signal?: AbortSignal): Promise<Channel>;
}

interface Link {
    readonly codec: EnvelopeCodec;
    readonly detach: () => void;
    readonly frame: FrameProtocol;
}

export class Endpoint {
    readonly host: Host;
    readonly #connectChannel?: EndpointOptions["connectChannel"];
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #openListeners = new Set<() => void>();
    readonly #ports = new Map<string, Port>();
    readonly #route = new Route();
    readonly #links = new Set<Link>();
    #gateway?: Link;
    #connecting?: Promise<void>;

    constructor(options: EndpointOptions = {}) {
        this.host = options.host ?? createTransportId();
        this.#connectChannel = options.connectChannel;
    }

    get connected(): boolean {
        return this.#gateway !== undefined;
    }

    bind(port: PortName, host: Host = this.host): Port {
        const key = `${host}\u0000${port}`;
        let binding = this.#ports.get(key);
        if (binding === undefined || binding.closed) {
            binding = this.#route.bind(host, port);
            this.#ports.set(key, binding);
        }
        return binding;
    }

    async connect(
        host: Host,
        port: PortName,
        signal?: AbortSignal,
    ): Promise<Connection> {
        if (host !== this.host) await this.#connect(signal);
        return this.bind(port).connect(host, port);
    }

    async accept(
        channel: Channel,
        lifecycle?: { attached(host: Host): void; detached(host: Host): void },
    ): Promise<() => void> {
        const frame = new FrameProtocol(channel, { role: "acceptor" });
        const request = await frame.nextOpen();
        if (request === undefined || request.service !== ENVELOPE_SERVICE) {
            frame.close();
            throw new Error(`Expected ${ENVELOPE_SERVICE} service.`);
        }
        const codec = new EnvelopeCodec(
            new FrameStreamChannel(await request.accept()),
        );
        return this.#link(frame, codec, this.#route.attach(codec, channel, lifecycle));
    }

    onTransportClose(listener: (error?: Error) => void): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    onTransportOpen(listener: () => void): () => void {
        this.#openListeners.add(listener);
        return () => this.#openListeners.delete(listener);
    }

    disconnect(): void {
        if (this.#gateway !== undefined) this.#close(this.#gateway);
    }

    async reconnect(): Promise<void> {
        this.disconnect();
        await this.#connect();
    }

    close(): void {
        for (const port of this.#ports.values()) port.close();
        this.#ports.clear();
        for (const link of [...this.#links]) this.#close(link);
        this.#closeListeners.clear();
        this.#openListeners.clear();
    }

    async #connect(signal?: AbortSignal): Promise<void> {
        if (this.#gateway !== undefined) return;
        if (this.#connecting !== undefined) return await this.#connecting;
        const connectChannel = this.#connectChannel;
        if (connectChannel === undefined) throw new Error("Endpoint cannot connect.");
        const connecting = (async () => {
            const channel = await connectChannel(signal);
            const frame = new FrameProtocol(channel, {
                role: "opener",
            });
            const codec = new EnvelopeCodec(
                new FrameStreamChannel(await frame.open(ENVELOPE_SERVICE)),
            );
            const detach = this.#route.gateway(codec, channel);
            const link: Link = { codec, detach, frame };
            this.#links.add(link);
            this.#gateway = link;
            for (const listener of this.#openListeners) listener();
            codec.onClose((error) => {
                if (this.#gateway === link) this.#gateway = undefined;
                this.#links.delete(link);
                for (const listener of this.#closeListeners) listener(error);
            });
        })();
        this.#connecting = connecting;
        try {
            await connecting;
        } finally {
            this.#connecting = undefined;
        }
    }

    #link(frame: FrameProtocol, codec: EnvelopeCodec, detach: () => void): () => void {
        const link: Link = { codec, detach, frame };
        this.#links.add(link);
        codec.onClose(() => this.#links.delete(link));
        return () => this.#close(link);
    }

    #close(link: Link): void {
        if (!this.#links.delete(link)) return;
        if (this.#gateway === link) this.#gateway = undefined;
        link.detach();
        link.codec.close();
        link.frame.close();
    }
}

export { Connection, Port } from "./route/Route.js";
