import {
    Endpoint,
    Rpc,
    Stream,
    createRemoteError,
    toRemoteErrorBody,
    type Channel,
    type ControlClientKind,
    type ControlHostDefinition,
    type ControlPortContext,
    type ControlPortDefinition,
    type JsonValue,
    type MessageStream,
    type Port,
    type RpcContext,
    controlErrorCodes,
} from "@portable-devshell/shared";
import {
    negotiateControlProtocol,
    readControlHelloRequest,
} from "../../Protocol.js";
import type {
    ControlAcceptedChannel,
    ControlTransportAdmission,
    ControlTransportListener,
} from "../channel/Listener.js";

export interface ControlTransportRouteProvider {
    hosts(): readonly ControlHostDefinition[];
    onChange(listener: () => void): () => void;
}

export interface ControlTransportServerOptions {
    listeners: readonly ControlTransportListener[];
    onConnectionDetached?: (connectionId: string) => void;
    routes: ControlTransportRouteProvider;
}

interface Session {
    readonly admission: ControlTransportAdmission;
    peer?: ControlClientKind;
    pending?: {
        peer: ControlClientKind;
        protocolVersion: string;
        requestId: string;
    };
    protocolVersion?: string;
}

interface PreparedContext {
    readonly context: ControlPortContext;
    finish(ok: boolean): void;
}

interface BoundPort {
    readonly port: Port;
    readonly rpc: Rpc;
    readonly stream: Stream;
    readonly offOpen: () => void;
}

interface ActiveConnection {
    readonly channel: Channel;
    detach?: () => void;
}

export class ControlTransportServer {
    readonly #endpoint = new Endpoint({ host: "server" });
    readonly #ports = new Map<string, BoundPort>();
    readonly #sessions = new Map<string, Session>();
    readonly #connections = new Set<ActiveConnection>();
    readonly #onConnectionDetached: (connectionId: string) => void;
    readonly #routes: ControlTransportRouteProvider;
    #unsubscribeRoutes?: () => void;
    #listeners: ControlTransportListener[];
    readonly #startedListeners: ControlTransportListener[] = [];
    #closePromise?: Promise<void>;
    #startPromise?: Promise<void>;
    #started = false;
    #stopping = false;

    constructor(options: ControlTransportServerOptions) {
        if (options.listeners.length === 0)
            throw new Error(
                "Control transport server requires at least one listener.",
            );
        this.#listeners = [...options.listeners];
        this.#onConnectionDetached =
            options.onConnectionDetached ?? (() => undefined);
        this.#routes = options.routes;
        this.#syncPorts();
    }

    async start(): Promise<void> {
        if (this.#startPromise !== undefined) return await this.#startPromise;
        const start = this.#startAfterClose();
        this.#startPromise = start;
        try {
            await start;
        } finally {
            if (this.#startPromise === start) this.#startPromise = undefined;
        }
    }

    async #startAfterClose(): Promise<void> {
        const close = this.#closePromise;
        if (close !== undefined) await close;
        if (this.#started) return;
        if (this.#startedListeners.length > 0) await this.#closeListeners();
        await this.#startInternal();
    }

    async close(): Promise<void> {
        this.#stopping = true;
        if (this.#closePromise !== undefined) return await this.#closePromise;
        const close = this.#closeAfterStart();
        this.#closePromise = close;
        try {
            await close;
        } finally {
            if (this.#closePromise === close) this.#closePromise = undefined;
        }
    }

    async replaceListener(
        previous: ControlTransportListener,
        next: ControlTransportListener,
    ): Promise<void> {
        if (!this.#started)
            throw new Error("Control transport server is not started.");
        const index = this.#listeners.indexOf(previous);
        if (index < 0 || !this.#startedListeners.includes(previous))
            throw new Error("Control transport listener is not active.");

        const accept = (connection: ControlAcceptedChannel) =>
            void this.#accept(connection);
        await next.start(accept);
        try {
            await previous.close();
        } catch (error) {
            const rollbackFailures: unknown[] = [];
            await next.close().catch((rollbackError) => {
                rollbackFailures.push(rollbackError);
                if (!this.#startedListeners.includes(next))
                    this.#startedListeners.push(next);
            });
            await previous.start(accept).catch((rollbackError) => {
                rollbackFailures.push(rollbackError);
            });
            if (rollbackFailures.length > 0)
                throw new AggregateError(
                    [error, ...rollbackFailures],
                    "Control transport listener replacement failed and rollback was incomplete.",
                );
            throw error;
        }
        this.#listeners[index] = next;
        const startedIndex = this.#startedListeners.indexOf(previous);
        this.#startedListeners[startedIndex] = next;
    }

    async #startInternal(): Promise<void> {
        this.#stopping = false;
        this.#subscribeRoutes();
        try {
            for (const listener of this.#listeners) {
                await listener.start(
                    (connection) => void this.#accept(connection),
                );
                this.#startedListeners.push(listener);
            }
            this.#started = true;
        } catch (error) {
            this.#stopping = true;
            this.#unsubscribeRouteChanges();
            this.#closeConnections();
            try {
                await this.#closeListeners();
            } catch (closeError) {
                throw new AggregateError(
                    [error, closeError],
                    "Control transport server failed to start and clean up.",
                );
            }
            throw error;
        }
    }

    async #closeAfterStart(): Promise<void> {
        await this.#startPromise?.catch(() => undefined);
        await this.#closeInternal();
    }

    async #closeInternal(): Promise<void> {
        this.#stopping = true;
        this.#unsubscribeRouteChanges();
        this.#closeConnections();
        try {
            await this.#closeListeners();
        } finally {
            this.#started = false;
        }
    }

    #subscribeRoutes(): void {
        if (this.#unsubscribeRoutes !== undefined) return;
        this.#syncPorts();
        this.#unsubscribeRoutes = this.#routes.onChange(() =>
            this.#syncPorts(),
        );
    }

    #unsubscribeRouteChanges(): void {
        this.#unsubscribeRoutes?.();
        this.#unsubscribeRoutes = undefined;
    }

    #closeConnections(): void {
        for (const connection of this.#connections) {
            connection.detach?.();
            connection.channel.close();
        }
        this.#connections.clear();
    }

    async #closeListeners(): Promise<void> {
        const failures: unknown[] = [];
        const listeners = this.#startedListeners.splice(0);
        const failed = new Set<ControlTransportListener>();
        for (const listener of [...listeners].reverse())
            await listener.close().catch((error) => {
                failed.add(listener);
                failures.push(error);
            });
        for (const listener of listeners)
            if (failed.has(listener)) this.#startedListeners.push(listener);
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                "Control transport listeners failed to close.",
            );
    }

    async #accept({
        admission,
        channel,
    }: ControlAcceptedChannel): Promise<void> {
        if (this.#stopping) {
            channel.close(new Error("Control transport server is stopping."));
            return;
        }
        const active: ActiveConnection = { channel };
        this.#connections.add(active);
        try {
            active.detach = await this.#endpoint.accept(channel, {
                attached: (host) => this.#sessions.set(host, { admission }),
                detached: (host) => {
                    this.#sessions.delete(host);
                    this.#onConnectionDetached(host);
                },
            });
        } catch (error) {
            this.#connections.delete(active);
            channel.close(
                error instanceof Error ? error : new Error(String(error)),
            );
            return;
        }
        channel.onClose(() => this.#connections.delete(active));
    }

    #syncPorts(): void {
        const definitions = new Map<
            string,
            { host: string; port: ControlPortDefinition }
        >();
        for (const host of this.#routes.hosts())
            for (const port of host.ports)
                definitions.set(`${host.host}\u0000${port.name}`, {
                    host: host.host,
                    port,
                });

        for (const [key, bound] of this.#ports)
            if (!definitions.has(key)) {
                bound.offOpen();
                bound.stream.close();
                bound.rpc.close();
                bound.port.close();
                this.#ports.delete(key);
            }

        for (const [key, definition] of definitions) {
            if (this.#ports.has(key)) continue;
            const port = this.#endpoint.bind(
                definition.port.name,
                definition.host,
            );
            const handlers = Object.fromEntries(
                definition.port.operations.map((operation) => [
                    operation.name,
                    async (payload: unknown, rpc: RpcContext) => {
                        const prepared = this.#context(
                            rpc.local.host,
                            definition.port.name,
                            operation.name,
                            payload as JsonValue | undefined,
                            rpc,
                        );
                        try {
                            const result = await operation.handle(
                                {
                                    id: rpc.requestId,
                                    name: operation.name,
                                    ...(payload === undefined
                                        ? {}
                                        : { payload: payload as JsonValue }),
                                },
                                prepared.context,
                            );
                            prepared.finish(true);
                            return result;
                        } catch (error) {
                            prepared.finish(false);
                            throw error;
                        }
                    },
                ]),
            );
            const rpc = new Rpc(port, handlers);
            const stream = new Stream(port);
            const streamHandlers = new Map(
                (definition.port.streams ?? []).map((operation) => [
                    operation.name,
                    operation.handle,
                ]),
            );
            const offOpen = stream.onOpen(
                async (messageStream, name, payload, peer, local) => {
                    const handle = streamHandlers.get(name);
                    if (handle === undefined) {
                        await messageStream.cancel({
                            code: "method_not_found",
                            message: `Stream method ${name} was not found.`,
                        });
                        return;
                    }
                    const controller = new AbortController();
                    messageStream.onClose(() => controller.abort());
                    messageStream.onCancel(() => controller.abort());
                    const context = this.#streamContext(
                        local.host,
                        peer.host,
                        messageStream,
                        controller.signal,
                    );
                    try {
                        await handle(
                            messageStream,
                            {
                                id: messageStream.id,
                                name,
                                ...(payload === undefined
                                    ? {}
                                    : { payload: payload as JsonValue }),
                            },
                            context,
                        );
                    } catch (error) {
                        const body = toRemoteErrorBody(error);
                        await messageStream.cancel(
                            body === undefined
                                ? { message: String(error) }
                                : {
                                      code: body.code,
                                      ...(body.details === undefined
                                          ? {}
                                          : { details: body.details }),
                                      message: body.message,
                                      retryable: body.retryable,
                                  },
                        );
                    }
                },
            );
            this.#ports.set(key, { port, rpc, stream, offOpen });
        }
    }

    #context(
        host: string,
        port: string,
        operation: string,
        payload: JsonValue | undefined,
        rpc: RpcContext,
    ): PreparedContext {
        const session = this.#sessions.get(rpc.peer.host)!;
        if (host === "@control" && port === "server" && operation === "hello") {
            if (session.peer !== undefined)
                throw createRemoteError({
                    code: controlErrorCodes.clientIdentityInvalid,
                    message:
                        "Control connection identity is already negotiated.",
                    retryable: false,
                });
            if (session.pending !== undefined)
                throw createRemoteError({
                    code: controlErrorCodes.clientIdentityInvalid,
                    message:
                        "Control connection identity negotiation is already in progress.",
                    retryable: false,
                });
            const request = readControlHelloRequest(payload);
            if (!session.admission.allowedPeers.includes(request.clientKind))
                throw createRemoteError({
                    code: controlErrorCodes.clientIdentityInvalid,
                    message: `Control transport subject ${session.admission.subject.id} cannot connect as ${request.clientKind}.`,
                    retryable: false,
                });
            const negotiated = negotiateControlProtocol(
                payload,
                request.clientKind,
            );
            const pending = {
                peer: request.clientKind,
                protocolVersion: String(negotiated.protocolVersion),
                requestId: rpc.requestId,
            };
            session.pending = pending;
            return {
                context: {
                    afterReply: rpc.afterReply,
                    connectionId: rpc.peer.host,
                    host,
                    peer: pending.peer,
                    protocolVersion: pending.protocolVersion,
                    requestId: rpc.requestId,
                    signal: rpc.signal,
                    subject: session.admission.subject,
                },
                finish: (ok) => {
                    if (session.pending !== pending) return;
                    if (ok) {
                        session.peer = pending.peer;
                        session.protocolVersion = pending.protocolVersion;
                    }
                    session.pending = undefined;
                },
            };
        }
        if (session.peer === undefined) {
            throw createRemoteError({
                code: controlErrorCodes.clientIdentityRequired,
                message:
                    "server.hello must be the first request on a Control connection.",
                retryable: false,
            });
        }
        return {
            context: {
                afterReply: rpc.afterReply,
                connectionId: rpc.peer.host,
                host,
                peer: session.peer,
                ...(session.protocolVersion === undefined
                    ? {}
                    : { protocolVersion: session.protocolVersion }),
                requestId: rpc.requestId,
                signal: rpc.signal,
                subject: session.admission.subject,
            },
            finish() {},
        };
    }

    #streamContext(
        host: string,
        peerHost: string,
        stream: MessageStream,
        signal: AbortSignal,
    ): ControlPortContext {
        const session = this.#sessions.get(peerHost)!;
        if (session.peer === undefined)
            throw createRemoteError({
                code: controlErrorCodes.clientIdentityRequired,
                message:
                    "server.hello must be the first request on a Control connection.",
                retryable: false,
            });
        return {
            afterReply: (action) => queueMicrotask(() => void action()),
            connectionId: peerHost,
            host,
            peer: session.peer,
            ...(session.protocolVersion === undefined
                ? {}
                : { protocolVersion: session.protocolVersion }),
            requestId: stream.id,
            signal,
            subject: session.admission.subject,
        };
    }
}
