import type {
    Envelope,
    EnvelopeCodec,
} from "../../envelope/Codec.js";
import type { Packet } from "../../packet/Packet.js";
import type { Address, Host, PortName } from "../Address.js";
import type { Channel } from "../channel/Channel.js";

export const PEER_PROMOTION_PORT = "transport";
export const PEER_PROMOTION_METHOD = "transport.peer.promote";

export type PacketListener = (
    packet: Packet,
    source: Address,
    destination: Address,
    incoming?: Channel,
) => Promise<void> | void;

export class Connection {
    readonly local: Address;
    readonly remote: Address;
    readonly #port: Port;
    readonly #direct?: { codec: EnvelopeCodec; channel: Channel };

    constructor(
        port: Port,
        remote: Address,
        local: Address = port.local,
        direct?: { codec: EnvelopeCodec; channel: Channel },
    ) {
        this.#port = port;
        this.#direct = direct;
        this.local = local;
        this.remote = remote;
    }

    get connected(): boolean {
        return !this.#port.closed &&
            (this.#direct === undefined
                ? this.#port.canReach(this.remote)
                : !this.#direct.channel.closed);
    }

    send(packet: Packet): Promise<void> {
        if (!this.connected) throw new Error("Connection is closed.");
        if (this.#direct !== undefined)
            return this.#direct.codec.send({
                source: this.local, dest: this.remote, packet,
            });
        return this.#port.send(this.remote, packet, this.local);
    }

    onPacket(listener: (packet: Packet) => Promise<void> | void): () => void {
        return this.#port.onPacket((packet, source, destination, incoming) => {
            if (
                (this.#direct === undefined ||
                    incoming === this.#direct.channel) &&
                source.host === this.remote.host &&
                source.port === this.remote.port &&
                destination.host === this.local.host &&
                destination.port === this.local.port
            )
                return listener(packet);
        });
    }

    onClose(listener: (error?: Error) => void): () => void {
        const offPort = this.#port.onClose(listener);
        const offRoute = this.#direct === undefined
            ? this.#port.onUnreachable(this.remote, listener)
            : this.#direct.codec.onClose(listener);
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

    connect(
        host: Host,
        port: PortName = this.local.port,
        local: Address = this.local,
    ): Connection {
        return new Connection(this, { host, port }, local);
    }

    connectVia(
        host: Host,
        port: PortName,
        codec: EnvelopeCodec,
        channel: Channel,
        local: Address = this.local,
    ): Connection {
        return new Connection(this, { host, port }, local, { codec, channel });
    }

    connectIncoming(
        host: Host,
        port: PortName,
        local: Address,
        incoming: Channel,
    ): Connection {
        const codec = this.#route.codecFor(incoming);
        return codec === undefined
            ? this.connect(host, port, local)
            : this.connectVia(host, port, codec, incoming, local);
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

    send(
        dest: Address,
        packet: Packet,
        source: Address = this.local,
    ): Promise<void> {
        if (this.#closed) throw new Error("Port is closed.");
        return this.#route.send(source, dest, packet);
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

    async receive(
        packet: Packet,
        source: Address,
        destination: Address = this.local,
        incoming?: Channel,
    ): Promise<void> {
        for (const listener of this.#listeners)
            await listener(packet, source, destination, incoming);
    }
}

export class Route {
    readonly #ports = new Map<Host, Map<PortName, Port>>();
    readonly #peers = new Map<Host, EnvelopeCodec>();
    readonly #incomingCodecs = new WeakMap<Channel, EnvelopeCodec>();
    // A second channel from the same Host is a candidate until the existing
    // channel actually closes. Verifier replies use their incoming channel.
    readonly #peerCandidates = new Map<Host, Set<EnvelopeCodec>>();
    readonly #reachability = new Set<{
        dest: Address;
        listener: (error?: Error) => void;
        reachable: boolean;
    }>();
    #gateway?: EnvelopeCodec;

    codecFor(channel: Channel): EnvelopeCodec | undefined {
        return this.#incomingCodecs.get(channel);
    }

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
            (dest.host !== "*" &&
                this.#ports.get("*")?.has(dest.port) === true) ||
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
        channel: Channel,
        lifecycle?: { attached(host: Host): void; detached(host: Host): void },
        preserveExisting = false,
        authorizePromotion?: (host: Host, channel: Channel) => boolean,
    ): () => void {
        const hosts = new Set<Host>();
        this.#incomingCodecs.set(channel, codec);
        const detach = (error?: Error) => {
            this.#incomingCodecs.delete(channel);
            for (const host of hosts) {
                const candidates = this.#peerCandidates.get(host);
                if (this.#peers.get(host) === codec) {
                    const replacement = candidates?.values().next().value;
                    if (replacement !== undefined) {
                        candidates!.delete(replacement);
                        this.#peers.set(host, replacement);
                    } else {
                        this.#peers.delete(host);
                    }
                } else {
                    candidates?.delete(codec);
                }
                if (candidates?.size === 0) this.#peerCandidates.delete(host);
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
            const host = envelope.source.host;
            const packet = envelope.packet as {
                protocol?: string;
                type?: string;
                method?: string;
                id?: string;
            } | null;
            const promote =
                packet?.protocol === "rpc" &&
                packet.type === "request" &&
                packet.method === PEER_PROMOTION_METHOD &&
                typeof packet.id === "string" &&
                envelope.source.port === PEER_PROMOTION_PORT &&
                envelope.dest.port === PEER_PROMOTION_PORT;
            const active = this.#peers.get(host);
            if (promote && preserveExisting && active !== codec &&
                authorizePromotion?.(host, channel) !== true) {
                void codec.send({
                    source: envelope.dest,
                    dest: envelope.source,
                    packet: {
                        protocol: "rpc", type: "error", id: packet.id,
                        error: {
                            code: "transport.peerPromotionUnverified",
                            message: "Peer promotion requires an authorized candidate.",
                            retryable: false,
                        },
                    },
                }).catch((error) => codec.close(normalizeError(error)));
                return;
            }
            if (!preserveExisting) {
                // Independent Control sessions may reuse a Host identity.
                // Retain the ordinary latest-peer behavior for those endpoints.
                this.#peers.set(host, codec);
            } else if (promote && active !== codec) {
                // The new gateway was verified before requesting promotion.
                // Retain the old channel for rollback until it closes.
                let candidates = this.#peerCandidates.get(host);
                if (candidates === undefined) {
                    candidates = new Set<EnvelopeCodec>();
                    this.#peerCandidates.set(host, candidates);
                }
                candidates.delete(codec);
                if (active !== undefined) candidates.add(active);
                this.#peers.set(host, codec);
            } else if (active === undefined) {
                this.#peers.set(host, codec);
            } else if (active !== codec) {
                let candidates = this.#peerCandidates.get(host);
                if (candidates === undefined) {
                    candidates = new Set<EnvelopeCodec>();
                    this.#peerCandidates.set(host, candidates);
                }
                candidates.add(codec);
            }
            this.#refreshReachability();
            if (promote) {
                void codec.send({
                    source: envelope.dest,
                    dest: envelope.source,
                    packet: { protocol: "rpc", type: "reply", id: packet.id, message: { promoted: true } },
                }).catch((error) => codec.close(normalizeError(error)));
            } else {
                void this.#dispatch(envelope, codec, channel).catch((error) =>
                    codec.close(normalizeError(error)),
                );
            }
        });
        const offClose = codec.onClose(detach);
        return () => {
            offEnvelope();
            offClose();
            detach();
        };
    }

    gateway(codec: EnvelopeCodec, channel: Channel, staged = false): () => void {
        this.#incomingCodecs.set(channel, codec);
        if (!staged) this.activateGateway(codec);
        const offEnvelope = codec.onEnvelope((envelope) => {
            // Only replies to candidate-specific verification calls may enter
            // the local routing table before cutover. Ordinary traffic stays
            // on the established gateway until handshake succeeds.
            if (staged && this.#gateway !== codec) {
                const packet = envelope.packet as { protocol?: string; type?: string } | null;
                if (packet?.protocol !== "rpc" ||
                    (packet.type !== "reply" && packet.type !== "error")) return;
            }
            void this.#dispatch(envelope, codec, channel).catch((error) =>
                codec.close(normalizeError(error)),
            );
        });
        const offClose = codec.onClose((error) => {
            this.#incomingCodecs.delete(channel);
            if (this.#gateway === codec) {
                this.#gateway = undefined;
                this.#refreshReachability(error);
            }
        });
        return () => {
            offEnvelope();
            offClose();
            this.#incomingCodecs.delete(channel);
            if (this.#gateway === codec) {
                this.#gateway = undefined;
                this.#refreshReachability();
            }
        };
    }

    activateGateway(codec: EnvelopeCodec): void {
        this.#gateway = codec;
        this.#refreshReachability();
    }

    restoreGateway(codec: EnvelopeCodec): void {
        this.activateGateway(codec);
    }

    send(source: Address, dest: Address, packet: Packet): Promise<void> {
        return this.#dispatch({ source, dest, packet });
    }

    async #dispatch(
        envelope: Envelope,
        incoming?: EnvelopeCodec,
        channel?: Channel,
    ): Promise<void> {
        if (envelope.dest.host === "*") {
            const deliveries: Array<Promise<void> | void> = [];
            for (const [host, ports] of this.#ports) {
                if (host === "*") continue;
                if (host === envelope.source.host) continue;
                const port = ports.get(envelope.dest.port);
                if (port !== undefined)
                    deliveries.push(
                        port.receive(
                            envelope.packet,
                            envelope.source,
                            { host, port: envelope.dest.port },
                            channel,
                        ),
                    );
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

        const exact = this.#ports
            .get(envelope.dest.host)
            ?.get(envelope.dest.port);
        if (exact !== undefined) {
            await exact.receive(
                envelope.packet,
                envelope.source,
                envelope.dest,
                channel,
            );
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
        const fallback = this.#ports.get("*")?.get(envelope.dest.port);
        if (fallback !== undefined) {
            await fallback.receive(
                envelope.packet,
                envelope.source,
                envelope.dest,
                channel,
            );
            return;
        }
        const message =
            "No route for " + envelope.dest.host + ":" + envelope.dest.port + ".";
        if (incoming !== undefined &&
            typeof envelope.packet === "object" && envelope.packet !== null) {
            const packet = envelope.packet as Record<string, unknown>;
            if (typeof packet.id === "string" && packet.protocol === "rpc") {
                if (packet.type === "request") {
                    await incoming.send({
                        source: envelope.dest,
                        dest: envelope.source,
                        packet: {
                            protocol: "rpc",
                            type: "error",
                            id: packet.id,
                            error: { code: "route_not_found", message, retryable: false },
                        },
                    });
                }
                return;
            }
            if (typeof packet.id === "string" && packet.protocol === "stream") {
                if (packet.type === "open") {
                    await incoming.send({
                        source: envelope.dest,
                        dest: envelope.source,
                        packet: {
                            protocol: "stream",
                            type: "cancel",
                            id: packet.id,
                            error: { code: "route_not_found", message, retryable: false },
                        },
                    });
                }
                return;
            }
            if (packet.protocol === "event") return;
        }
        throw new Error(
            message,
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
