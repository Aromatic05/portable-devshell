import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

import type { ControlErrorBody } from "../error/ErrorBodyControl.js";
import type { JsonValue } from "../type/TypeJsonValue.js";
import { asInstanceName, type InstanceName } from "../type/identity/TypeIdentityInstanceName.js";
import { Channel } from "./Channel.js";
import { Codec, type Destination, type Peer } from "./Codec.js";
import { resolveControlSocketPath } from "./ControlEndpoint.js";
import { PrefixRoute, type PrefixRouteEvent, type PrefixRouteIncoming } from "./PrefixRoute.js";

export interface ClientEvent {
    id: string;
    replyTo?: string;
    streamId?: string;
    destination: Destination;
    name: `${string}.${string}`;
    payload?: JsonValue;
    error?: ControlErrorBody;
    seq?: number;
}

export type ClientConnectionMode = "short" | "persistent";

export interface ClientConnectionOptions {
    mapError(error: unknown): Error;
    mapRemoteError(error: ControlErrorBody): Error;
    mode?: ClientConnectionMode;
    peer: Exclude<Peer, "server">;
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export interface OpenedClientStream {
    acknowledgement: ClientEvent;
    stream: ClientStream;
}

export interface ControlClientModule {
    openStream(operation: string, payload?: unknown): Promise<OpenedClientStream>;
    request<TResult>(operation: string, payload?: unknown): Promise<TResult>;
}

export interface InstanceClientModule {
    openStream(instance: string, operation: string, payload?: unknown): Promise<OpenedClientStream>;
    request<TResult>(instance: string, operation: string, payload?: unknown): Promise<TResult>;
}

interface PendingRequest {
    destination: Destination;
    expectsStream: boolean;
    id: string;
    module: string;
    reject(error: Error): void;
    resolve(event: ClientEvent): void;
}

interface ClientStreamState {
    closeError?: Error;
    closed: boolean;
    destination: Destination;
    events: ClientEvent[];
    id: string;
    localClosed: boolean;
    module: string;
    terminal: boolean;
    waiters: Array<{ reject(error: Error): void; resolve(event: ClientEvent): void }>;
}

export class ClientStream {
    readonly #nextEvent: () => Promise<ClientEvent>;
    readonly #send: (operation: string, payload?: JsonValue) => Promise<void>;
    readonly #close: () => void;
    readonly id: string;
    #closed = false;

    constructor(
        id: string,
        actions: {
            close(): void;
            nextEvent(): Promise<ClientEvent>;
            send(operation: string, payload?: JsonValue): Promise<void>;
        }
    ) {
        this.id = id;
        this.#nextEvent = actions.nextEvent;
        this.#send = actions.send;
        this.#close = actions.close;
    }

    async nextEvent(): Promise<ClientEvent> {
        return await this.#nextEvent();
    }

    async send(operation: string, payload?: JsonValue): Promise<void> {
        await this.#send(operation, payload);
    }

    close(): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#close();
    }
}

export class ClientConnection {
    readonly #mapError: (error: unknown) => Error;
    readonly #mapRemoteError: (error: ControlErrorBody) => Error;
    readonly #mode: ClientConnectionMode;
    readonly #peer: Exclude<Peer, "server">;
    readonly #socketFactory?: (path: string) => Socket;
    readonly #socketPath: string;
    #closed = false;
    #persistentFailure?: Error;
    #persistentGeneration = 0;
    #persistentSession?: ClientSession;
    #persistentSessionPromise?: Promise<ClientSession>;

    constructor(options: ClientConnectionOptions) {
        this.#mapError = options.mapError;
        this.#mapRemoteError = options.mapRemoteError;
        this.#mode = options.mode ?? "short";
        this.#peer = options.peer;
        this.#socketFactory = options.socketFactory;
        this.#socketPath = options.socketPath ?? resolveControlSocketPath(options.xdgRuntimeDir);
    }

    async request<TResult>(
        destination: Destination,
        module: string,
        operation: string,
        payload?: unknown
    ): Promise<TResult> {
        const reply = await this.requestEvent(destination, module, operation, payload);
        this.throwRemoteError(reply.error);
        return reply.payload as unknown as TResult;
    }

    async requestEvent(
        destination: Destination,
        module: string,
        operation: string,
        payload?: unknown
    ): Promise<ClientEvent> {
        let session: ClientSession | undefined;
        try {
            session = await this.#acquireSession();
            return await session.request(destination, module, operation, payload as JsonValue | undefined, false);
        } catch (error) {
            throw this.mapError(error);
        } finally {
            if (this.#mode === "short") {
                session?.close();
            }
        }
    }

    async openStream(
        destination: Destination,
        module: string,
        operation: string,
        payload?: unknown
    ): Promise<OpenedClientStream> {
        let session: ClientSession | undefined;
        try {
            session = await this.#acquireSession();
            const activeSession = session;
            const acknowledgement = await session.request(
                destination,
                module,
                operation,
                payload as JsonValue | undefined,
                true
            );
            this.throwRemoteError(acknowledgement.error);
            if (acknowledgement.streamId === undefined) {
                throw new Error("Stream acknowledgement did not include streamId.");
            }
            const streamId = acknowledgement.streamId;
            return {
                acknowledgement,
                stream: new ClientStream(streamId, {
                    close: () => {
                        if (this.#mode === "short") {
                            activeSession.close();
                        } else {
                            activeSession.closeStream(streamId);
                        }
                    },
                    nextEvent: async () => await activeSession.nextStreamEvent(streamId),
                    send: async (streamOperation, streamPayload) =>
                        await activeSession.sendStream(streamId, streamOperation, streamPayload)
                })
            };
        } catch (error) {
            if (this.#mode === "short") {
                session?.close();
            }
            throw this.mapError(error);
        }
    }

    async reconnect(): Promise<void> {
        if (this.#mode === "short") {
            return;
        }
        this.#assertOpen();
        this.#persistentGeneration += 1;
        const session = this.#persistentSession;
        this.#persistentSession = undefined;
        this.#persistentSessionPromise = undefined;
        this.#persistentFailure = undefined;
        session?.close();
        await this.#acquirePersistentSession();
    }

    close(): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#persistentGeneration += 1;
        const session = this.#persistentSession;
        this.#persistentSession = undefined;
        this.#persistentSessionPromise = undefined;
        this.#persistentFailure = undefined;
        session?.close();
    }

    throwRemoteError(error: ControlErrorBody | undefined): void {
        if (error !== undefined) {
            throw this.#mapRemoteError(error);
        }
    }

    mapError(error: unknown): Error {
        return this.#mapError(error);
    }

    async #acquireSession(): Promise<ClientSession> {
        this.#assertOpen();
        return this.#mode === "short" ? await this.#connect() : await this.#acquirePersistentSession();
    }

    async #acquirePersistentSession(): Promise<ClientSession> {
        this.#assertOpen();
        if (this.#persistentFailure !== undefined) {
            throw this.#persistentFailure;
        }
        if (this.#persistentSession !== undefined && !this.#persistentSession.closed) {
            return this.#persistentSession;
        }
        if (this.#persistentSessionPromise !== undefined) {
            return await this.#persistentSessionPromise;
        }

        const generation = this.#persistentGeneration;
        let promise!: Promise<ClientSession>;
        promise = this.#connect((session, error) => {
            if (generation !== this.#persistentGeneration || this.#closed) {
                return;
            }
            if (this.#persistentSession === session) {
                this.#persistentSession = undefined;
            }
            this.#persistentFailure = this.mapError(error ?? new Error("Client connection closed."));
        }).then((session) => {
            if (generation !== this.#persistentGeneration || this.#closed) {
                session.close();
                throw new Error("Client connection was reset while connecting.");
            }
            this.#persistentSession = session;
            return session;
        }).catch((error) => {
            const failure = this.mapError(error);
            if (generation === this.#persistentGeneration && !this.#closed) {
                this.#persistentFailure = failure;
            }
            throw failure;
        }).finally(() => {
            if (this.#persistentSessionPromise === promise) {
                this.#persistentSessionPromise = undefined;
            }
        });
        this.#persistentSessionPromise = promise;
        return await promise;
    }

    async #connect(onClose?: (session: ClientSession, error?: Error) => void): Promise<ClientSession> {
        const channel = await Channel.connect(this.#socketPath, { socketFactory: this.#socketFactory });
        const route = new PrefixRoute(new Codec(channel, { local: this.#peer, remote: "server" }), {
            eventIdPrefix: this.#peer
        });
        return new ClientSession(route, this.#peer, onClose);
    }

    #assertOpen(): void {
        if (this.#closed) {
            throw new Error("Client connection is closed.");
        }
    }
}

class ClientSession {
    readonly #route: PrefixRoute;
    readonly #peer: Exclude<Peer, "server">;
    readonly #onClose?: (session: ClientSession, error?: Error) => void;
    readonly #pending = new Map<string, PendingRequest>();
    readonly #streams = new Map<string, ClientStreamState>();
    #closed = false;
    #closeError?: Error;

    constructor(
        route: PrefixRoute,
        peer: Exclude<Peer, "server">,
        onClose?: (session: ClientSession, error?: Error) => void
    ) {
        this.#route = route;
        this.#peer = peer;
        this.#onClose = onClose;
        route.onEvent((incoming) => this.#accept(incoming));
        route.onClose((error) => this.#finishClose(error));
    }

    get closed(): boolean {
        return this.#closed;
    }

    async request(
        destination: Destination,
        module: string,
        operation: string,
        payload: JsonValue | undefined,
        expectsStream: boolean
    ): Promise<ClientEvent> {
        this.#assertOpen();
        const id = `${this.#peer}-${randomUUID()}`;
        const response = new Promise<ClientEvent>((resolve, reject) => {
            this.#pending.set(id, { destination, expectsStream, id, module, reject, resolve });
        });
        void response.catch(() => undefined);
        try {
            await this.#route.send(destination, module, {
                id,
                name: operation,
                ...(payload === undefined ? {} : { payload })
            });
        } catch (error) {
            const pending = this.#pending.get(id);
            this.#pending.delete(id);
            pending?.reject(error instanceof Error ? error : new Error(String(error)));
        }
        return await response;
    }

    async nextStreamEvent(streamId: string): Promise<ClientEvent> {
        const stream = this.#requireStream(streamId);
        const queued = stream.events.shift();
        if (queued !== undefined) {
            if (isTerminalStreamEvent(queued)) {
                this.#finishStream(stream);
            }
            return queued;
        }
        if (stream.closed || stream.localClosed || stream.terminal || this.#closed) {
            throw stream.closeError ?? this.#closeError ?? new Error("Client stream is closed.");
        }
        return await new Promise<ClientEvent>((resolve, reject) => {
            stream.waiters.push({ reject, resolve });
        });
    }

    async sendStream(streamId: string, operation: string, payload?: JsonValue): Promise<void> {
        const stream = this.#requireStream(streamId);
        if (stream.closed || stream.localClosed || stream.terminal || this.#closed) {
            throw stream.closeError ?? this.#closeError ?? new Error("Client stream is closed.");
        }
        await this.#route.send(stream.destination, stream.module, {
            id: `${this.#peer}-${randomUUID()}`,
            streamId,
            name: operation,
            ...(payload === undefined ? {} : { payload })
        });
    }

    closeStream(streamId: string): void {
        const stream = this.#streams.get(streamId);
        if (stream === undefined || stream.localClosed || stream.closed) {
            return;
        }
        if (stream.terminal) {
            this.#finishStream(stream);
            return;
        }
        stream.localClosed = true;
        stream.closeError = new Error("Client stream is closed.");
        stream.events.length = 0;
        for (const waiter of stream.waiters.splice(0)) {
            waiter.reject(stream.closeError);
        }
        void this.#route.send(stream.destination, "stream", {
            id: `${this.#peer}-${randomUUID()}`,
            streamId,
            name: "cancel"
        }).catch((error) => {
            this.close(error instanceof Error ? error : new Error(String(error)));
        });
    }

    close(error?: Error): void {
        this.#route.close(error);
        this.#finishClose(error);
    }

    #accept(incoming: PrefixRouteIncoming): void {
        const event = toClientEvent(incoming);
        if (event.replyTo !== undefined) {
            this.#acceptReply(event, incoming);
            return;
        }
        if (event.streamId !== undefined) {
            this.#acceptStream(event);
            return;
        }
        this.close(new Error(`Unexpected uncorrelated event ${event.name}.`));
    }

    #acceptReply(event: ClientEvent, incoming: PrefixRouteIncoming): void {
        const pending = this.#pending.get(event.replyTo!);
        if (pending === undefined) {
            this.close(new Error(`Unexpected replyTo ${event.replyTo}.`));
            return;
        }
        if (pending.destination !== incoming.destination || pending.module !== incoming.module) {
            this.close(new Error(`Reply ${event.replyTo} was addressed to the wrong route.`));
            return;
        }
        if (pending.expectsStream) {
            if (event.error === undefined && event.streamId === undefined) {
                this.close(new Error("Stream acknowledgement must include streamId."));
                return;
            }
            if (event.error === undefined) {
                if (this.#streams.has(event.streamId!)) {
                    this.close(new Error(`Duplicate streamId ${event.streamId}.`));
                    return;
                }
                this.#streams.set(event.streamId!, {
                    closed: false,
                    destination: pending.destination,
                    events: [],
                    id: event.streamId!,
                    localClosed: false,
                    module: pending.module,
                    terminal: false,
                    waiters: []
                });
            }
        } else if (event.streamId !== undefined) {
            this.close(new Error("A normal reply must not establish a stream."));
            return;
        }
        this.#pending.delete(pending.id);
        pending.resolve(event);
    }

    #acceptStream(event: ClientEvent): void {
        const stream = this.#streams.get(event.streamId!);
        if (stream === undefined) {
            this.close(new Error(`Unexpected streamId ${event.streamId}.`));
            return;
        }
        if (event.destination !== stream.destination) {
            this.close(new Error(`Stream ${event.streamId} was addressed to the wrong destination.`));
            return;
        }
        const terminal = isTerminalStreamEvent(event);
        if (stream.localClosed) {
            if (terminal) {
                this.#finishStream(stream);
            }
            return;
        }
        if (stream.terminal) {
            this.close(new Error(`Stream ${event.streamId} emitted after termination.`));
            return;
        }
        if (terminal) {
            stream.terminal = true;
        }
        const waiter = stream.waiters.shift();
        if (waiter === undefined) {
            stream.events.push(event);
            return;
        }
        waiter.resolve(event);
        if (terminal) {
            for (const remaining of stream.waiters.splice(0)) {
                remaining.reject(new Error("Client stream is closed."));
            }
            this.#finishStream(stream);
        }
    }

    #finishStream(stream: ClientStreamState): void {
        stream.closed = true;
        stream.events.length = 0;
        this.#streams.delete(stream.id);
    }

    #finishClose(error?: Error): void {
        if (error !== undefined && this.#closeError === undefined) {
            this.#closeError = error;
        }
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        const failure = this.#closeError ?? new Error("Client connection closed.");
        for (const pending of this.#pending.values()) {
            pending.reject(failure);
        }
        this.#pending.clear();
        for (const stream of this.#streams.values()) {
            stream.closed = true;
            stream.closeError = failure;
            stream.events.length = 0;
            for (const waiter of stream.waiters.splice(0)) {
                waiter.reject(failure);
            }
        }
        this.#streams.clear();
        this.#onClose?.(this, this.#closeError);
    }

    #requireStream(streamId: string): ClientStreamState {
        const stream = this.#streams.get(streamId);
        if (stream === undefined) {
            throw this.#closeError ?? new Error("Client stream is closed.");
        }
        return stream;
    }

    #assertOpen(): void {
        if (this.#closed) {
            throw this.#closeError ?? new Error("Client session is closed.");
        }
    }
}

export function controlClientModule(connection: ClientConnection, module: string): ControlClientModule {
    return {
        openStream: (operation, payload) => connection.openStream("@control", module, operation, payload),
        request: (operation, payload) => connection.request("@control", module, operation, payload)
    };
}

export function instanceClientModule(connection: ClientConnection, module: string): InstanceClientModule {
    return {
        openStream: (instance, operation, payload) =>
            connection.openStream(asInstanceName(instance), module, operation, payload),
        request: (instance, operation, payload) =>
            connection.request(asInstanceName(instance), module, operation, payload)
    };
}

export function readClientSubscriptionEvents(
    destination: InstanceName,
    payload: JsonValue | undefined
): ClientEvent[] {
    if (!isRecord(payload) || !Array.isArray(payload.events)) {
        throw new Error("Invalid subscription acknowledgement.");
    }
    return payload.events.map((value) => {
        if (!isRecord(value) || typeof value.type !== "string" || typeof value.seq !== "number") {
            throw new Error("Invalid initial subscription event.");
        }
        return {
            id: `initial-${value.seq}`,
            destination,
            name: value.type as ClientEvent["name"],
            payload: value,
            seq: value.seq
        };
    });
}

function toClientEvent(incoming: PrefixRouteIncoming): ClientEvent {
    const event: PrefixRouteEvent = incoming.event;
    return {
        id: event.id,
        ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }),
        ...(event.streamId === undefined ? {} : { streamId: event.streamId }),
        destination: incoming.destination,
        name: `${incoming.module}.${event.name}`,
        ...(event.payload === undefined ? {} : { payload: event.payload }),
        ...(event.error === undefined ? {} : { error: event.error }),
        ...(event.seq === undefined ? {} : { seq: event.seq })
    };
}

function isTerminalStreamEvent(event: ClientEvent): boolean {
    return event.name === "stream.completed" || event.name === "stream.cancelled";
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
