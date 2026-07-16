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

export interface ClientConnectionOptions {
    mapError(error: unknown): Error;
    mapRemoteError(error: ControlErrorBody): Error;
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
    id: string;
    expectsStream: boolean;
    reject(error: Error): void;
    resolve(event: ClientEvent): void;
}

export class ClientStream {
    readonly #nextEvent: () => Promise<ClientEvent>;
    readonly #send: (operation: string, payload?: JsonValue) => Promise<void>;
    readonly #close: () => void;
    readonly id: string;

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
        this.#close();
    }
}

export class ClientConnection {
    readonly #mapError: (error: unknown) => Error;
    readonly #mapRemoteError: (error: ControlErrorBody) => Error;
    readonly #peer: Exclude<Peer, "server">;
    readonly #socketFactory?: (path: string) => Socket;
    readonly #socketPath: string;

    constructor(options: ClientConnectionOptions) {
        this.#mapError = options.mapError;
        this.#mapRemoteError = options.mapRemoteError;
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
        const session = await this.#connect();
        try {
            return await session.request(destination, module, operation, payload as JsonValue | undefined, false);
        } catch (error) {
            throw this.mapError(error);
        } finally {
            session.close();
        }
    }

    async openStream(
        destination: Destination,
        module: string,
        operation: string,
        payload?: unknown
    ): Promise<OpenedClientStream> {
        const session = await this.#connect();
        try {
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
            return {
                acknowledgement,
                stream: new ClientStream(acknowledgement.streamId, {
                    close: () => session.close(),
                    nextEvent: async () => await session.nextStreamEvent(),
                    send: async (streamOperation, streamPayload) =>
                        await session.sendStream(destination, module, streamOperation, streamPayload)
                })
            };
        } catch (error) {
            session.close();
            throw this.mapError(error);
        }
    }

    throwRemoteError(error: ControlErrorBody | undefined): void {
        if (error !== undefined) {
            throw this.#mapRemoteError(error);
        }
    }

    mapError(error: unknown): Error {
        return this.#mapError(error);
    }

    async #connect(): Promise<ClientSession> {
        try {
            const channel = await Channel.connect(this.#socketPath, { socketFactory: this.#socketFactory });
            const route = new PrefixRoute(new Codec(channel, { local: this.#peer, remote: "server" }), {
                eventIdPrefix: this.#peer
            });
            return new ClientSession(route, this.#peer);
        } catch (error) {
            throw this.mapError(error);
        }
    }
}

class ClientSession {
    readonly #route: PrefixRoute;
    readonly #peer: Exclude<Peer, "server">;
    readonly #streamEvents: ClientEvent[] = [];
    readonly #streamWaiters: Array<{ reject(error: Error): void; resolve(event: ClientEvent): void }> = [];
    #pending?: PendingRequest;
    #streamId?: string;
    #closed = false;
    #closeError?: Error;

    constructor(route: PrefixRoute, peer: Exclude<Peer, "server">) {
        this.#route = route;
        this.#peer = peer;
        route.onEvent((incoming) => this.#accept(incoming));
        route.onClose((error) => this.#finishClose(error));
    }

    async request(
        destination: Destination,
        module: string,
        operation: string,
        payload: JsonValue | undefined,
        expectsStream: boolean
    ): Promise<ClientEvent> {
        if (this.#pending !== undefined) {
            throw new Error("Client session already has a pending request.");
        }
        if (this.#closed) {
            throw this.#closeError ?? new Error("Client session is closed.");
        }
        const id = `${this.#peer}-${randomUUID()}`;
        const response = new Promise<ClientEvent>((resolve, reject) => {
            this.#pending = { expectsStream, id, reject, resolve };
        });
        void response.catch(() => undefined);
        try {
            await this.#route.send(destination, module, {
                id,
                name: operation,
                ...(payload === undefined ? {} : { payload })
            });
        } catch (error) {
            this.#pending = undefined;
            throw error;
        }
        return await response;
    }

    async nextStreamEvent(): Promise<ClientEvent> {
        const queued = this.#streamEvents.shift();
        if (queued !== undefined) {
            return queued;
        }
        if (this.#closed) {
            throw this.#closeError ?? new Error("Client stream is closed.");
        }
        if (this.#streamId === undefined) {
            throw new Error("No client stream is active.");
        }
        return await new Promise<ClientEvent>((resolve, reject) => {
            this.#streamWaiters.push({ reject, resolve });
        });
    }

    async sendStream(
        destination: Destination,
        module: string,
        operation: string,
        payload?: JsonValue
    ): Promise<void> {
        if (this.#streamId === undefined) {
            throw new Error("No client stream is active.");
        }
        await this.#route.send(destination, module, {
            id: `${this.#peer}-${randomUUID()}`,
            streamId: this.#streamId,
            name: operation,
            ...(payload === undefined ? {} : { payload })
        });
    }

    close(error?: Error): void {
        this.#route.close(error);
        this.#finishClose(error);
    }

    #accept(incoming: PrefixRouteIncoming): void {
        const event = toClientEvent(incoming);
        if (event.replyTo !== undefined) {
            const pending = this.#pending;
            if (pending === undefined || event.replyTo !== pending.id) {
                this.close(new Error(`Unexpected replyTo ${event.replyTo}.`));
                return;
            }
            if (pending.expectsStream) {
                if (event.error === undefined && event.streamId === undefined) {
                    this.close(new Error("Stream acknowledgement must include streamId."));
                    return;
                }
                if (event.error === undefined) {
                    this.#streamId = event.streamId;
                }
            } else if (event.streamId !== undefined) {
                this.close(new Error("A normal reply must not establish a stream."));
                return;
            }
            this.#pending = undefined;
            pending.resolve(event);
            return;
        }
        if (event.streamId === undefined || event.streamId !== this.#streamId) {
            this.close(new Error(`Unexpected streamId ${event.streamId ?? "<missing>"}.`));
            return;
        }
        const waiter = this.#streamWaiters.shift();
        if (waiter === undefined) {
            this.#streamEvents.push(event);
        } else {
            waiter.resolve(event);
        }
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
        const pending = this.#pending;
        this.#pending = undefined;
        pending?.reject(failure);
        for (const waiter of this.#streamWaiters.splice(0)) {
            waiter.reject(failure);
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

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
