import type {
    Envelope,
    EnvelopeCodec,
} from "../../envelope/Codec.js";
import type { Packet } from "../../packet/Packet.js";
import type { Address, Host, PortName } from "../Address.js";

export type PacketListener = (
    packet: Packet,
    source: Address,
) => Promise<void> | void;

export class Connection {
    readonly local: Address;
    readonly remote: Address;
    readonly #port: Port;

    constructor(port: Port, remote: Address) {
        this.#port = port;
        this.local = port.local;
        this.remote = remote;
    }

    get connected(): boolean {
        return !this.#port.closed && this.#port.canReach(this.remote);
    }

    send(packet: Packet): Promise<void> {
        if (!this.connected) throw new Error("Connection is closed.");
        return this.#port.send(this.remote, packet);
    }

    onPacket(listener: (packet: Packet) => Promise<void> | void): () => void {
        return this.#port.onPacket((packet, source) => {
            if (
                source.host === this.remote.host &&
                source.port === this.remote.port
            )
                return listener(packet);
        });
    }

    onClose(listener: (error?: Error) => void): () => void {
        const offPort = this.#port.onClose(listener);
        const offRoute = this.#port.onUnreachable(this.remote, listener);
        return () => {
            offPort();
            offRoute();
        };
    }
}

export class Port {
    readonly local: Address;
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #listeners = new Set<PacketListener>();
    readonly #route: Route;
    readonly #unbind: () => void;
    #closed = false;

    constructor(route: Route, local: Address, unbind: () => void) {
        this.#route = route;
        this.local = local;
        this.#unbind = unbind;
    }

    get closed(): boolean {
        return this.#closed;
    }

    connect(host: Host, port: PortName = this.local.port): Connection {
        return new Connection(this, { host, port });
    }

    canReach(dest: Address): boolean {
        return this.#route.canReach(dest);
    }

    onClose(listener: (error?: Error) => void): () => void {
        if (this.#closed) {
            queueMicrotask(() => listener());
            return () => undefined;
        }
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    onUnreachable(dest: Address, listener: (error?: Error) => void): () => void {
        return this.#route.onUnreachable(dest, listener);
    }

    send(dest: Address, packet: Packet): Promise<void> {
        if (this.#closed) throw new Error("Port is closed.");
        return this.#route.send(this.local, dest, packet);
    }

    broadcast(port: PortName, packet: Packet): Promise<void> {
        return this.send({ host: "*", port }, packet);
    }

    onPacket(listener: PacketListener): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#listeners.clear();
        this.#unbind();
        const listeners = [...this.#closeListeners];
        this.#closeListeners.clear();
        for (const listener of listeners) listener();
    }

    async receive(packet: Packet, source: Address): Promise<void> {
        for (const listener of this.#listeners) await listener(packet, source);
    }
}

export class Route {
    readonly #ports = new Map<Host, Map<PortName, Port>>();
    readonly #peers = new Map<Host, EnvelopeCodec>();
    readonly #reachability = new Set<{
        dest: Address;
        listener: (error?: Error) => void;
        reachable: boolean;
    }>();
    #gateway?: EnvelopeCodec;

    bind(host: Host, port: PortName): Port {
        let ports = this.#ports.get(host);
        if (ports === undefined) {
            ports = new Map();
            this.#ports.set(host, ports);
        }
        if (ports.has(port))
            throw new Error(host + ":" + port + " is already bound.");
        const binding = new Port(this, { host, port }, () => {
            ports!.delete(port);
            if (ports!.size === 0) this.#ports.delete(host);
            this.#refreshReachability();
        });
        ports.set(port, binding);
        this.#refreshReachability();
        return binding;
    }

    canReach(dest: Address): boolean {
        return (
            this.#ports.get(dest.host)?.has(dest.port) === true ||
            this.#peers.has(dest.host) ||
            this.#gateway !== undefined
        );
    }

    onUnreachable(
        dest: Address,
        listener: (error?: Error) => void,
    ): () => void {
        const watcher = {
            dest,
            listener,
            reachable: this.canReach(dest),
        };
        this.#reachability.add(watcher);
        return () => this.#reachability.delete(watcher);
    }

    attach(
        codec: EnvelopeCodec,
        lifecycle?: { attached(host: Host): void; detached(host: Host): void },
    ): () => void {
        const hosts = new Set<Host>();
        const detach = (error?: Error) => {
            for (const host of hosts) {
                if (this.#peers.get(host) === codec) this.#peers.delete(host);
                lifecycle?.detached(host);
            }
            hosts.clear();
            this.#refreshReachability(error);
        };
        const offEnvelope = codec.onEnvelope((envelope) => {
            if (!hosts.has(envelope.source.host)) {
                hosts.add(envelope.source.host);
                lifecycle?.attached(envelope.source.host);
            }
            this.#peers.set(envelope.source.host, codec);
            this.#refreshReachability();
            void this.#dispatch(envelope, codec).catch((error) =>
                codec.close(normalizeError(error)),
            );
        });
        const offClose = codec.onClose(detach);
        return () => {
            offEnvelope();
            offClose();
            detach();
        };
    }

    gateway(codec: EnvelopeCodec): () => void {
        this.#gateway = codec;
        this.#refreshReachability();
        const offEnvelope = codec.onEnvelope((envelope) =>
            void this.#dispatch(envelope, codec).catch((error) =>
                codec.close(normalizeError(error)),
            ),
        );
        const offClose = codec.onClose((error) => {
            if (this.#gateway === codec) {
                this.#gateway = undefined;
                this.#refreshReachability(error);
            }
        });
        return () => {
            offEnvelope();
            offClose();
            if (this.#gateway === codec) {
                this.#gateway = undefined;
                this.#refreshReachability();
            }
        };
    }

    send(source: Address, dest: Address, packet: Packet): Promise<void> {
        return this.#dispatch({ source, dest, packet });
    }

    async #dispatch(envelope: Envelope, incoming?: EnvelopeCodec): Promise<void> {
        if (envelope.dest.host === "*") {
            const deliveries: Array<Promise<void> | void> = [];
            for (const [host, ports] of this.#ports) {
                if (host === envelope.source.host) continue;
                const port = ports.get(envelope.dest.port);
                if (port !== undefined)
                    deliveries.push(port.receive(envelope.packet, envelope.source));
            }
            for (const [host, peer] of this.#peers) {
                if (host === envelope.source.host || peer === incoming) continue;
                deliveries.push(peer.send(envelope));
            }
            if (this.#gateway !== undefined && this.#gateway !== incoming)
                deliveries.push(this.#gateway.send(envelope));
            await Promise.all(deliveries);
            return;
        }

        const port = this.#ports.get(envelope.dest.host)?.get(envelope.dest.port);
        if (port !== undefined) {
            await port.receive(envelope.packet, envelope.source);
            return;
        }
        const peer = this.#peers.get(envelope.dest.host);
        if (peer !== undefined && peer !== incoming) {
            await peer.send(envelope);
            return;
        }
        if (this.#gateway !== undefined && this.#gateway !== incoming) {
            await this.#gateway.send(envelope);
            return;
        }
        throw new Error(
            "No route for " + envelope.dest.host + ":" + envelope.dest.port + ".",
        );
    }

    #refreshReachability(error?: Error): void {
        for (const watcher of this.#reachability) {
            const reachable = this.canReach(watcher.dest);
            if (watcher.reachable && !reachable) watcher.listener(error);
            watcher.reachable = reachable;
        }
    }
}

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
