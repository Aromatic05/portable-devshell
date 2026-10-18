import { EnvelopeCodec } from "../envelope/Codec.js";
import { FrameProtocol } from "../frame/Protocol.js";
import { FrameStreamChannel } from "../frame/Stream.js";
import { Rpc } from "../packet/Rpc.js";
import { createTransportId, type Host, type PortName } from "./Address.js";
import type { Channel } from "./channel/Channel.js";
import { Connection, Port, Route } from "./route/Route.js";

const ENVELOPE_SERVICE = "envelope";
const CONNECT_RETRY_DELAY_MS = [100, 250] as const;

export interface EndpointOptions {
    readonly host?: Host;
    /** Keep a validated accepted peer during a candidate handoff, rather than replacing it on first traffic. */
    readonly preserveAcceptedPeers?: boolean;
    connectChannel?(signal?: AbortSignal): Promise<Channel>;
    /** Authenticate a newly opened link before releasing regular RPC/stream requests. */
    initializeConnection?(connect: (host: Host, port: PortName) => Connection): Promise<void>;
}

interface Link {
    readonly channel?: Channel;
    readonly codec: EnvelopeCodec;
    readonly detach: () => void;
    readonly frame: FrameProtocol;
}

export class Endpoint {
    readonly host: Host;
    readonly #connectChannel?: EndpointOptions["connectChannel"];
    readonly #initializeConnection?: EndpointOptions["initializeConnection"];
    readonly #preserveAcceptedPeers: boolean;
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #openListeners = new Set<() => void>();
    readonly #ports = new Map<string, Port>();
    readonly #route = new Route();
    readonly #links = new Set<Link>();
    #gateway?: Link;
    #standbyGateway?: Link;
    #connecting?: Promise<void>;

    constructor(options: EndpointOptions = {}) {
        this.host = options.host ?? createTransportId();
        this.#connectChannel = options.connectChannel;
        this.#initializeConnection = options.initializeConnection;
        this.#preserveAcceptedPeers = options.preserveAcceptedPeers ?? false;
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
        return this.#link(frame, codec, this.#route.attach(
            codec, channel, lifecycle, this.#preserveAcceptedPeers,
        ));
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

    async reconnect(options: {
        preserveExisting?: boolean;
        signal?: AbortSignal;
        verify?: (connect: (host: Host, port: PortName) => Connection) => Promise<void>;
    } = {}): Promise<void> {
        options.signal?.throwIfAborted();
        const previous = options.preserveExisting ? this.#gateway : undefined;
        if (previous === undefined) {
            this.disconnect();
            await this.#connect(options.signal);
            try {
                await untilAborted(options.verify?.(
                    (host, port) => this.bind(port).connect(host, port),
                ), options.signal);
            } catch (error) {
                this.disconnect();
                throw error;
            }
            return;
        }
        if (this.#standbyGateway !== undefined)
            throw new Error("An Endpoint replacement is already being verified.");
        this.#standbyGateway = previous;
        let candidate: Link | undefined;
        let verifiedHost: Host | undefined;
        try {
            // Do not change the regular Route gateway until the replacement
            // has passed its application handshake. Only verifier RPCs use it.
            candidate = await this.#openLink(true, options.signal);
            const link = candidate;
            await untilAborted(options.verify?.((host, port) => {
                verifiedHost = host;
                return this.bind(port).connectVia(host, port, link.codec, link.channel!);
            }), options.signal);
            options.signal?.throwIfAborted();
            if (!this.#links.has(link))
                throw new Error("Endpoint candidate closed during verification.");
            this.#route.activateGateway(link.codec);
            this.#gateway = link;
            // Keep the old inbound gateway alive until the Worker has
            // acknowledged outbound peer promotion on the new channel. This
            // reuses worker.ping, which existing Rust Workers already accept.
            if (verifiedHost !== undefined) {
                const rpc = new Rpc(
                    this.bind("core").connectVia(
                        verifiedHost, "core", link.codec, link.channel!,
                    ),
                );
                try {
                    await rpc.request("worker.ping", { __devshellActivatePeer: true }, options.signal);
                } finally {
                    rpc.close();
                }
            }
            options.signal?.throwIfAborted();
            for (const listener of this.#openListeners) listener();
        } catch (error) {
            if (candidate !== undefined) this.#close(candidate);
            if (this.#links.has(previous)) {
                this.#route.restoreGateway(previous.codec);
                this.#gateway = previous;
            } else {
                for (const listener of this.#closeListeners) listener();
            }
            throw error;
        } finally {
            this.#standbyGateway = undefined;
        }
        this.#close(previous);
    }

    close(): void {
        for (const port of this.#ports.values()) port.close();
        this.#ports.clear();
        for (const link of [...this.#links]) this.#close(link);
        this.#closeListeners.clear();
        this.#openListeners.clear();
    }

    async #connect(signal?: AbortSignal): Promise<void> {
        if (this.#connecting !== undefined) return await this.#connecting;
        if (this.#gateway !== undefined) return;
        const connecting = (async () => {
            await this.#openLink(false, signal);
        })();
        this.#connecting = connecting;
        try {
            await connecting;
        } finally {
            this.#connecting = undefined;
        }
    }

    async #openLink(staged: boolean, signal?: AbortSignal): Promise<Link> {
        const connectChannel = this.#connectChannel;
        if (connectChannel === undefined) throw new Error("Endpoint cannot connect.");
        // Retry only transport establishment, never RPC or tool execution.
        const channel = await connectChannelWithRetry(connectChannel, signal);
        const abort = () => channel.close(
            signal?.reason instanceof Error ? signal.reason : new Error("Transport connection aborted."),
        );
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        const frame = new FrameProtocol(channel, { role: "opener" });
        let codec: EnvelopeCodec;
        try {
            codec = new EnvelopeCodec(
                new FrameStreamChannel(await frame.open(ENVELOPE_SERVICE)),
            );
        } catch (error) {
            signal?.removeEventListener("abort", abort);
            frame.close();
            throw error;
        }
        const detach = this.#route.gateway(codec, channel, staged);
        const link: Link = { channel, codec, detach, frame };
        this.#links.add(link);
        if (!staged) this.#gateway = link;
        codec.onClose((error) => {
            const wasGateway = this.#gateway === link;
            if (wasGateway) this.#gateway = undefined;
            this.#links.delete(link);
            if (wasGateway && this.#standbyGateway === undefined)
                for (const listener of this.#closeListeners) listener(error);
        });
        try {
            await this.#initializeConnection?.((host, port) =>
                staged
                    ? this.bind(port).connectVia(host, port, codec, channel)
                    : this.bind(port).connect(host, port),
            );
            if (!this.#links.has(link) || (!staged && this.#gateway !== link))
                throw new Error("Endpoint connection closed during initialization.");
            // Aborting at this boundary must close the candidate through the
            // catch path, not leave an unowned Link behind.
            signal?.throwIfAborted();
        } catch (error) {
            this.#close(link);
            throw error;
        } finally {
            signal?.removeEventListener("abort", abort);
        }
        if (!staged)
            for (const listener of this.#openListeners) listener();
        return link;
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

async function connectChannelWithRetry(
    connect: NonNullable<EndpointOptions["connectChannel"]>,
    signal?: AbortSignal,
): Promise<Channel> {
    for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
            return await connect(signal);
        } catch (error) {
            if (signal?.aborted || attempt >= CONNECT_RETRY_DELAY_MS.length ||
                !isTransientConnectionError(error)) throw error;
            await waitBeforeReconnect(CONNECT_RETRY_DELAY_MS[attempt]!, signal);
        }
    }
}

function isTransientConnectionError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (candidate.retryable === true) return true;
    if (typeof candidate.code === "string" &&
        ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "control.notRunning"].includes(candidate.code))
        return true;
    return typeof candidate.message === "string" &&
        /^(WebSocket connection failed or was rejected\.|WebSocket closed during connect: 1006\b)/u.test(candidate.message);
}

async function waitBeforeReconnect(delayMs: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(signal?.reason ?? new Error("Connection cancelled."));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

export { Connection, Port } from "./route/Route.js";

async function untilAborted<T>(
    work: Promise<T> | undefined,
    signal?: AbortSignal,
): Promise<T | undefined> {
    if (work === undefined) return undefined;
    if (signal === undefined) return await work;
    signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const abort = () => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            reject(signal.reason ?? new Error("Endpoint verification aborted."));
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        void work.then(
            (value) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", abort);
                resolve(value);
            },
            (error: unknown) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", abort);
                reject(error);
            },
        );
    });
}
