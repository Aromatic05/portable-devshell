import { randomUUID } from "node:crypto";

import type { ControlErrorBody } from "../error/ErrorBodyControl.js";
import { toControlErrorBody } from "../error/ErrorBodyControl.js";
import { errorCodes } from "../error/ErrorCodeCatalog.js";
import { createError } from "../error/ErrorFactoryCreate.js";
import type { JsonValue } from "../type/TypeJsonValue.js";
import { Codec, type Destination, type Event, type Peer } from "./Codec.js";

export interface PrefixRouteEvent {
    id: string;
    replyTo?: string;
    streamId?: string;
    name: string;
    payload?: JsonValue;
    error?: ControlErrorBody;
    seq?: number;
}

export interface PrefixRouteIncoming {
    destination: Destination;
    module: string;
    peer: Peer;
    event: PrefixRouteEvent;
}

export interface PrefixRouteRequest {
    id: string;
    name: string;
    payload?: JsonValue;
    seq?: number;
}

export interface PrefixRouteStreamOptions {
    onClose?(): Promise<void> | void;
    onEvent?(event: PrefixRouteEvent, incoming: PrefixRouteIncoming): Promise<void> | void;
}

export interface PrefixRouteStream {
    readonly id: string;
    cancel(error: ControlErrorBody): Promise<void>;
    complete(payload?: JsonValue): Promise<void>;
    emit(name: string, payload?: JsonValue, seq?: number, module?: string): Promise<void>;
}

export interface PrefixRouteContext {
    readonly connectionId: string;
    readonly destination: Destination;
    readonly module: string;
    readonly peer: Exclude<Peer, "server">;
    readonly requestId: string;
    readonly signal: AbortSignal;
    afterReply(action: () => Promise<void> | void): void;
    openStream(initialPayload?: JsonValue, options?: PrefixRouteStreamOptions): Promise<PrefixRouteStream>;
}

export type PrefixRouteHandler = (
    request: PrefixRouteRequest,
    context: PrefixRouteContext
) => JsonValue | undefined | Promise<JsonValue | undefined>;

export interface PrefixRouteOperationDefinition {
    name: string;
    handle: PrefixRouteHandler;
}

export interface PrefixRouteModuleDefinition {
    name: string;
    operations: readonly PrefixRouteOperationDefinition[];
}

export interface PrefixRouteDestinationDefinition {
    destination: Destination;
    modules: readonly PrefixRouteModuleDefinition[];
}

type OperationMap = ReadonlyMap<string, PrefixRouteHandler>;
type ModuleMap = ReadonlyMap<string, OperationMap>;

export interface PrefixRouteSnapshot {
    readonly destinations: ReadonlyMap<Destination, ModuleMap>;
}

export interface PrefixRouteOptions {
    connectionId?: string;
    getSnapshot?: () => PrefixRouteSnapshot;
    eventIdPrefix?: string;
}

interface ActiveServerStream {
    closed: boolean;
    destination: Destination;
    id: string;
    module: string;
    options: PrefixRouteStreamOptions;
}

export class PrefixRoute {
    readonly #codec: Codec;
    readonly #connectionId: string;
    readonly #getSnapshot?: () => PrefixRouteSnapshot;
    readonly #eventIdPrefix: string;
    readonly #abortController = new AbortController();
    readonly #eventListeners = new Set<(incoming: PrefixRouteIncoming) => void>();
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #serverStreams = new Map<string, ActiveServerStream>();
    #closed = false;
    #closeError?: Error;

    static snapshot(definitions: readonly PrefixRouteDestinationDefinition[]): PrefixRouteSnapshot {
        const destinations = new Map<Destination, ModuleMap>();
        for (const destinationDefinition of definitions) {
            if (destinations.has(destinationDefinition.destination)) {
                throw new Error(`Duplicate route destination: ${destinationDefinition.destination}`);
            }
            const modules = new Map<string, OperationMap>();
            for (const moduleDefinition of destinationDefinition.modules) {
                validateRouteSegment(moduleDefinition.name, "module");
                if (modules.has(moduleDefinition.name)) {
                    throw new Error(`Duplicate route module: ${destinationDefinition.destination}/${moduleDefinition.name}`);
                }
                const operations = new Map<string, PrefixRouteHandler>();
                for (const operation of moduleDefinition.operations) {
                    validateRouteSegment(operation.name, "operation");
                    if (operations.has(operation.name)) {
                        throw new Error(
                            `Duplicate route operation: ${destinationDefinition.destination}/${moduleDefinition.name}.${operation.name}`
                        );
                    }
                    operations.set(operation.name, operation.handle);
                }
                modules.set(moduleDefinition.name, operations);
            }
            destinations.set(destinationDefinition.destination, modules);
        }
        return { destinations };
    }

    constructor(codec: Codec, options: PrefixRouteOptions = {}) {
        this.#codec = codec;
        this.#connectionId = options.connectionId ?? randomUUID();
        this.#getSnapshot = options.getSnapshot;
        this.#eventIdPrefix = options.eventIdPrefix ?? codec.localPeer;
        codec.onEvent((event) => {
            void this.#accept(event).catch((error) => {
                this.close(error instanceof Error ? error : new Error(String(error)));
            });
        });
        codec.onClose((error) => this.#finishClose(error));
    }

    get connectionId(): string {
        return this.#connectionId;
    }

    get closed(): boolean {
        return this.#closed;
    }

    async send(destination: Destination, module: string, event: PrefixRouteEvent): Promise<void> {
        validateRouteSegment(module, "module");
        validateRouteSegment(event.name, "operation");
        await this.#codec.send({
            id: event.id,
            ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }),
            ...(event.streamId === undefined ? {} : { streamId: event.streamId }),
            destination,
            name: `${module}.${event.name}`,
            ...(event.payload === undefined ? {} : { payload: event.payload }),
            ...(event.error === undefined ? {} : { error: event.error }),
            ...(event.seq === undefined ? {} : { seq: event.seq })
        });
    }

    onEvent(listener: (incoming: PrefixRouteIncoming) => void): () => void {
        this.#eventListeners.add(listener);
        return () => this.#eventListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        if (this.#closed) {
            queueMicrotask(() => listener(this.#closeError));
            return () => undefined;
        }
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    close(error?: Error): void {
        this.#codec.close(error);
        this.#finishClose(error);
    }

    async #accept(event: Event): Promise<void> {
        const incoming = toIncoming(event);
        if (this.#getSnapshot === undefined) {
            for (const listener of [...this.#eventListeners]) {
                listener(incoming);
            }
            return;
        }
        if (event.replyTo !== undefined) {
            throw protocolFailure("Clients must not send reply events to the server route.");
        }
        if (event.streamId !== undefined) {
            await this.#acceptStream(incoming);
            return;
        }
        await this.#route(incoming);
    }

    async #acceptStream(incoming: PrefixRouteIncoming): Promise<void> {
        const streamId = incoming.event.streamId!;
        const active = this.#serverStreams.get(streamId);
        if (incoming.module === "stream" && incoming.event.name === "cancel") {
            if (active === undefined) {
                return;
            }
            if (incoming.destination !== active.destination) {
                throw protocolFailure(`Stream ${streamId} was addressed to the wrong destination.`);
            }
            active.closed = true;
            this.#serverStreams.delete(streamId);
            await active.options.onClose?.();
            await this.send(active.destination, "stream", {
                id: this.#nextId(),
                streamId,
                name: "cancelled"
            });
            return;
        }
        if (active === undefined) {
            throw protocolFailure(`Unexpected streamId ${streamId}.`);
        }
        if (incoming.destination !== active.destination || incoming.module !== active.module) {
            throw protocolFailure(`Stream ${streamId} was addressed to the wrong route.`);
        }
        await active.options.onEvent?.(incoming.event, incoming);
    }

    async #route(incoming: PrefixRouteIncoming): Promise<void> {
        const snapshot = this.#getSnapshot!();
        const modules = snapshot.destinations.get(incoming.destination);
        if (modules === undefined) {
            await this.#sendErrorReply(incoming, createError({
                code: errorCodes.targetInvalid,
                message: `Destination ${incoming.destination} was not found.`,
                retryable: false
            }).toBody());
            return;
        }
        const operations = modules.get(incoming.module);
        if (operations === undefined) {
            await this.#sendErrorReply(incoming, createError({
                code: errorCodes.envelopeInvalid,
                message: `Module ${incoming.module} was not found for ${incoming.destination}.`,
                retryable: false
            }).toBody());
            return;
        }
        const handler = operations.get(incoming.event.name);
        if (handler === undefined) {
            await this.#sendErrorReply(incoming, createError({
                code: errorCodes.envelopeInvalid,
                message: `Operation ${incoming.module}.${incoming.event.name} was not found for ${incoming.destination}.`,
                retryable: false
            }).toBody());
            return;
        }

        const afterReply: Array<() => Promise<void> | void> = [];
        let openedStream: PrefixRouteStream | undefined;
        const context: PrefixRouteContext = {
            afterReply: (action) => afterReply.push(action),
            connectionId: this.#connectionId,
            destination: incoming.destination,
            module: incoming.module,
            openStream: async (initialPayload, options = {}) => {
                if (openedStream !== undefined || this.#serverStreams.has(incoming.event.id)) {
                    throw new Error(`Stream ${incoming.event.id} is already open.`);
                }
                const active: ActiveServerStream = {
                    closed: false,
                    destination: incoming.destination,
                    id: this.#nextId(),
                    module: incoming.module,
                    options
                };
                this.#serverStreams.set(active.id, active);
                openedStream = this.#createServerStream(active);
                await this.send(incoming.destination, incoming.module, {
                    id: this.#nextId(),
                    replyTo: incoming.event.id,
                    streamId: active.id,
                    name: incoming.event.name,
                    ...(initialPayload === undefined ? {} : { payload: initialPayload })
                });
                return openedStream;
            },
            peer: incoming.peer as Exclude<Peer, "server">,
            requestId: incoming.event.id,
            signal: this.#abortController.signal
        };

        try {
            const result = await handler({
                id: incoming.event.id,
                name: incoming.event.name,
                ...(incoming.event.payload === undefined ? {} : { payload: incoming.event.payload }),
                ...(incoming.event.seq === undefined ? {} : { seq: incoming.event.seq })
            }, context);
            if (openedStream === undefined) {
                await this.send(incoming.destination, incoming.module, {
                    id: this.#nextId(),
                    replyTo: incoming.event.id,
                    name: incoming.event.name,
                    ...(result === undefined ? {} : { payload: result })
                });
                for (const action of afterReply) {
                    queueMicrotask(() => {
                        void Promise.resolve(action()).catch((error) => {
                            process.emitWarning(error instanceof Error ? error : new Error(String(error)));
                        });
                    });
                }
            }
        } catch (error) {
            const body = normalizeError(error);
            if (openedStream !== undefined) {
                await openedStream.cancel(body);
            } else {
                await this.#sendErrorReply(incoming, body);
            }
        }
    }

    #createServerStream(active: ActiveServerStream): PrefixRouteStream {
        const finish = async (
            name: "completed" | "cancelled",
            payload?: JsonValue,
            error?: ControlErrorBody
        ) => {
            if (active.closed) {
                return;
            }
            active.closed = true;
            await this.send(active.destination, "stream", {
                id: this.#nextId(),
                streamId: active.id,
                name,
                ...(payload === undefined ? {} : { payload }),
                ...(error === undefined ? {} : { error })
            });
            this.#serverStreams.delete(active.id);
        };
        return {
            id: active.id,
            cancel: async (error) => await finish("cancelled", undefined, error),
            complete: async (payload) => await finish("completed", payload),
            emit: async (name, payload, seq, module = active.module) => {
                if (active.closed) {
                    throw new Error(`Stream ${active.id} is closed.`);
                }
                await this.send(active.destination, module, {
                    id: this.#nextId(),
                    streamId: active.id,
                    name,
                    ...(payload === undefined ? {} : { payload }),
                    ...(seq === undefined ? {} : { seq })
                });
            }
        };
    }

    async #sendErrorReply(incoming: PrefixRouteIncoming, error: ControlErrorBody): Promise<void> {
        await this.send(incoming.destination, incoming.module, {
            id: this.#nextId(),
            replyTo: incoming.event.id,
            name: incoming.event.name,
            error
        });
    }

    #finishClose(error?: Error): void {
        if (error !== undefined && this.#closeError === undefined) {
            this.#closeError = error;
        }
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#abortController.abort(this.#closeError);
        for (const active of this.#serverStreams.values()) {
            if (!active.closed) {
                active.closed = true;
                void active.options.onClose?.();
            }
        }
        this.#serverStreams.clear();
        const listeners = [...this.#closeListeners];
        this.#closeListeners.clear();
        for (const listener of listeners) {
            listener(this.#closeError);
        }
    }

    #nextId(): string {
        return `${this.#eventIdPrefix}-${randomUUID()}`;
    }
}

function toIncoming(event: Event): PrefixRouteIncoming {
    const [module, operation] = event.name.split(".");
    return {
        destination: event.destination,
        module: module!,
        peer: event.from,
        event: {
            id: event.id,
            ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }),
            ...(event.streamId === undefined ? {} : { streamId: event.streamId }),
            name: operation!,
            ...(event.payload === undefined ? {} : { payload: event.payload }),
            ...(event.error === undefined ? {} : { error: event.error }),
            ...(event.seq === undefined ? {} : { seq: event.seq })
        }
    };
}

function validateRouteSegment(value: string, kind: string): void {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(value)) {
        throw new Error(`Invalid route ${kind}: ${value}`);
    }
}

function normalizeError(error: unknown): ControlErrorBody {
    return toControlErrorBody(error) ?? createError({
        code: errorCodes.envelopeInvalid,
        cause: error,
        message: error instanceof Error ? error.message : String(error),
        retryable: false
    }).toBody();
}

function protocolFailure(message: string): Error {
    return createError({ code: errorCodes.envelopeInvalid, message, retryable: false });
}
