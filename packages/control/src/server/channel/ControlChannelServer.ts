import {
    Codec,
    PrefixRoute,
    createError,
    errorCodes,
    type Channel,
    type ControlClientKind,
    type PrefixRouteIncoming,
    type PrefixRouteSubject,
    type PrefixRouteSnapshot
} from "@portable-devshell/shared";

import { negotiateControlProtocol } from "../../control/service/ServiceRouteModule.js";

export interface ControlChannelRouteProvider {
    connectionClosed(connectionId: string): void;
    snapshot(): PrefixRouteSnapshot;
}

export interface ControlChannelListener {
    start(accept: (connection: ControlAcceptedChannel) => void): Promise<void>;
    close(): Promise<void>;
}

export interface ControlChannelAdmission {
    readonly allowedPeers: readonly ControlClientKind[];
    readonly subject: PrefixRouteSubject;
}

export interface ControlAcceptedChannel {
    readonly admission: ControlChannelAdmission;
    readonly channel: Channel;
}

export interface ControlChannelServerOptions {
    listeners: readonly ControlChannelListener[];
    routes: ControlChannelRouteProvider;
}

export class ControlChannelServer {
    #listeners: ControlChannelListener[];
    readonly #routes: ControlChannelRouteProvider;
    readonly #connections = new Map<string, PrefixRoute>();
    readonly #startedListeners: ControlChannelListener[] = [];
    #closePromise?: Promise<void>;
    #startPromise?: Promise<void>;
    #started = false;
    #stopping = false;

    constructor(options: ControlChannelServerOptions) {
        if (options.listeners.length === 0) {
            throw new Error("Control channel server requires at least one listener.");
        }
        this.#listeners = [...options.listeners];
        this.#routes = options.routes;
    }

    async start(): Promise<void> {
        if (this.#startPromise !== undefined) {
            return await this.#startPromise;
        }
        const start = this.#startAfterClose();
        this.#startPromise = start;
        try {
            await start;
        } finally {
            if (this.#startPromise === start) {
                this.#startPromise = undefined;
            }
        }
    }

    async #startAfterClose(): Promise<void> {
        const close = this.#closePromise;
        if (close !== undefined) {
            await close;
        }
        if (this.#started) {
            return;
        }
        if (this.#startedListeners.length > 0) {
            await this.#closeListeners();
        }
        await this.#startInternal();
    }

    async close(): Promise<void> {
        this.#stopping = true;
        if (this.#closePromise !== undefined) {
            return await this.#closePromise;
        }
        const close = this.#closeAfterStart();
        this.#closePromise = close;
        try {
            await close;
        } finally {
            if (this.#closePromise === close) {
                this.#closePromise = undefined;
            }
        }
    }

    async replaceListener(previous: ControlChannelListener, next: ControlChannelListener): Promise<void> {
        if (!this.#started) {
            throw new Error("Control channel server is not started.");
        }
        const index = this.#listeners.indexOf(previous);
        if (index < 0 || !this.#startedListeners.includes(previous)) {
            throw new Error("Control channel listener is not active.");
        }

        await next.start((connection) => this.#accept(connection));
        this.#listeners[index] = next;
        const startedIndex = this.#startedListeners.indexOf(previous);
        this.#startedListeners[startedIndex] = next;
        setImmediate(() => {
            void previous.close().catch(() => undefined);
        });
    }

    async #startInternal(): Promise<void> {
        this.#stopping = false;
        try {
            for (const listener of this.#listeners) {
                await listener.start((connection) => this.#accept(connection));
                this.#startedListeners.push(listener);
            }
            this.#started = true;
        } catch (error) {
            this.#stopping = true;
            this.#closeConnections();
            try {
                await this.#closeListeners();
            } catch (closeError) {
                throw new AggregateError(
                    [error, closeError],
                    "Control channel server failed to start and clean up."
                );
            }
            throw error;
        }
    }

    async #closeAfterStart(): Promise<void> {
        await this.#startPromise?.catch(() => undefined);
        await this.#closeInternal();
    }

    #accept(connection: ControlAcceptedChannel): void {
        const { admission, channel } = connection;
        if (this.#stopping) {
            channel.close(new Error("Control channel server is stopping."));
            return;
        }
        try {
            let negotiated:
                | { peer: ControlClientKind; protocolVersion: number }
                | undefined;
            let pending:
                | {
                      peer: ControlClientKind;
                      protocolVersion: number;
                      requestId: string;
                  }
                | undefined;
            const route = new PrefixRoute(new Codec(channel, { local: "server" }), {
                authorizeRequest: (incoming) => {
                    if (negotiated === undefined) {
                        assertHelloRequest(incoming);
                        if (pending !== undefined) {
                            throw createError({
                                code: errorCodes.controlClientIdentityInvalid,
                                message: "Control connection identity negotiation is already in progress.",
                                retryable: false,
                            });
                        }
                        const peer = readClientPeer(incoming.peer);
                        if (!admission.allowedPeers.includes(peer)) {
                            throw createError({
                                code: errorCodes.controlClientIdentityInvalid,
                                details: {
                                    allowedPeers: [...admission.allowedPeers],
                                    requestedPeer: peer,
                                    subject: admission.subject.id,
                                },
                                message: `Control transport subject ${admission.subject.id} cannot connect as ${peer}.`,
                                retryable: false,
                            });
                        }
                        const hello = negotiateControlProtocol(
                            incoming.event.payload,
                            peer,
                        );
                        pending = {
                            peer,
                            protocolVersion: hello.protocolVersion,
                            requestId: incoming.event.id,
                        };
                        return;
                    }
                    if (isHelloRequest(incoming)) {
                        throw createError({
                            code: errorCodes.controlClientIdentityInvalid,
                            message: "Control connection identity is already negotiated.",
                            retryable: false,
                        });
                    }
                    if (incoming.peer !== negotiated.peer) {
                        throw createError({
                            code: errorCodes.controlClientIdentityInvalid,
                            message: `Control connection is negotiated as ${negotiated.peer}, not ${incoming.peer}.`,
                            retryable: false,
                        });
                    }
                },
                eventIdPrefix: "server",
                getConnectionContext: () => ({
                    protocolVersion:
                        negotiated?.protocolVersion ?? pending?.protocolVersion,
                    subject: admission.subject,
                }),
                getSnapshot: () => this.#routes.snapshot(),
                onRequestResult: (incoming, result) => {
                    if (pending?.requestId !== incoming.event.id) return;
                    if (result.ok) {
                        negotiated = {
                            peer: pending.peer,
                            protocolVersion: pending.protocolVersion,
                        };
                    }
                    pending = undefined;
                },
            });
            this.#connections.set(route.connectionId, route);
            channel.onClose(() => {
                this.#connections.delete(route.connectionId);
                this.#routes.connectionClosed(route.connectionId);
            });
        } catch (error) {
            channel.close(error instanceof Error ? error : new Error(String(error)));
        }
    }

    async #closeInternal(): Promise<void> {
        this.#stopping = true;
        this.#closeConnections();
        try {
            await this.#closeListeners();
        } finally {
            this.#started = false;
        }
    }

    #closeConnections(): void {
        for (const route of this.#connections.values()) {
            route.close();
        }
        this.#connections.clear();
    }

    async #closeListeners(): Promise<void> {
        const failures: unknown[] = [];
        const listeners = this.#startedListeners.splice(0);
        const failed = new Set<ControlChannelListener>();
        for (const listener of [...listeners].reverse()) {
            await listener.close().catch((error) => {
                failed.add(listener);
                failures.push(error);
            });
        }
        for (const listener of listeners) {
            if (failed.has(listener)) {
                this.#startedListeners.push(listener);
            }
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, "Control channel listeners failed to close.");
        }
    }
}

function assertHelloRequest(incoming: PrefixRouteIncoming): void {
    if (isHelloRequest(incoming)) return;
    throw createError({
        code: errorCodes.controlClientIdentityRequired,
        details: {
            destination: incoming.destination,
            module: incoming.module,
            operation: incoming.event.name,
        },
        message: "service.hello must be the first request on a Control connection.",
        retryable: false,
    });
}

function isHelloRequest(incoming: PrefixRouteIncoming): boolean {
    return (
        incoming.destination === "@control" &&
        incoming.module === "service" &&
        incoming.event.name === "hello" &&
        incoming.event.streamId === undefined
    );
}

function readClientPeer(peer: PrefixRouteIncoming["peer"]): ControlClientKind {
    if (peer === "cli" || peer === "tui" || peer === "web") return peer;
    throw createError({
        code: errorCodes.controlClientIdentityInvalid,
        message: "Server peer cannot initiate a Control client connection.",
        retryable: false,
    });
}
