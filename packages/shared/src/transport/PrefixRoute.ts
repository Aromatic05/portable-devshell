import { randomUUID } from "node:crypto";

import type { ControlErrorBody } from "../error/ErrorBodyControl.js";
import { errorCodes } from "../error/ErrorCodeCatalog.js";
import { createError } from "../error/ErrorFactoryCreate.js";
import { toControlErrorBody } from "../error/ErrorBodyControl.js";
import type { JsonValue } from "../type/TypeJsonValue.js";
import { Codec, type Destination, type Event, type Frame, type Peer } from "./Codec.js";

export interface PrefixRouteRequest {
    id: string;
    name: string;
    payload?: JsonValue;
    seq?: number;
}

export interface PrefixRouteStreamOptions {
    onClose?(): Promise<void> | void;
    onEvent?(event: Event, frame: Frame): Promise<void> | void;
}

export interface PrefixRouteStream {
    readonly id: string;
    cancel(error: ControlErrorBody): Promise<void>;
    complete(payload?: JsonValue): Promise<void>;
    emit(name: string, payload?: JsonValue, seq?: number): Promise<void>;
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
    requestIdPrefix?: string;
}

interface PendingRequest {
    expectsStream: boolean;
    id: string;
    reject(error: Error): void;
    resolve(frame: Frame): void;
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
    readonly #requestIdPrefix: string;
    readonly #abortController = new AbortController();
    readonly #streamFrames: Frame[] = [];
    readonly #streamWaiters: Array<{ reject(error: Error): void; resolve(frame: Frame): void }> = [];
    #pending?: PendingRequest;
    #clientStreamId?: string;
    #clientStreamEnded = false;
    #serverStream?: ActiveServerStream;
    #rootSent = false;
    #rootAccepted = false;
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
        this.#requestIdPrefix = options.requestIdPrefix ?? codec.localPeer;

        codec.onFrame((frame) => {
            void this.#accept(frame).catch((error) => {
                this.close(error instanceof Error ? error : new Error(String(error)));
            });
        });
        codec.onClose((error) => {
            this.#finishClose(error);
        });
    }

    get connectionId(): string {
        return this.#connectionId;
    }

    get streamId(): string | undefined {
        return this.#clientStreamId ?? this.#serverStream?.id;
    }

    async request(event: Event, id = this.#nextId()): Promise<Frame> {
        return await this.#sendRoot(event, id, false);
    }

    async openStream(event: Event, id = this.#nextId()): Promise<Frame> {
        return await this.#sendRoot(event, id, true);
    }

    async nextStreamFrame(): Promise<Frame> {
        const queued = this.#streamFrames.shift();
        if (queued !== undefined) {
            return queued;
        }
        if (this.#closed) {
            throw this.#closeError ?? new Error("PrefixRoute is closed.");
        }
        if (this.#clientStreamId === undefined && !this.#clientStreamEnded) {
            throw new Error("No client stream is active.");
        }
        return await new Promise<Frame>((resolve, reject) => {
            this.#streamWaiters.push({ reject, resolve });
        });
    }

    async sendStream(event: Event): Promise<void> {
        if (this.#clientStreamId === undefined || this.#clientStreamEnded) {
            throw new Error("No client stream is active.");
        }
        await this.#codec.send({
            id: this.#nextId(),
            streamId: this.#clientStreamId,
            event
        });
    }

    close(error?: Error): void {
        this.#codec.close(error);
        this.#finishClose(error);
    }

    async #sendRoot(event: Event, id: string, expectsStream: boolean): Promise<Frame> {
        if (this.#rootSent) {
            throw new Error("A dedicated PrefixRoute connection accepts only one root request.");
        }
        if (this.#closed) {
            throw this.#closeError ?? new Error("PrefixRoute is closed.");
        }
        this.#rootSent = true;

        const response = new Promise<Frame>((resolve, reject) => {
            this.#pending = { expectsStream, id, reject, resolve };
        });
        void response.catch(() => undefined);

        try {
            await this.#codec.send({ id, event });
        } catch (error) {
            this.#pending = undefined;
            throw error;
        }
        return await response;
    }

    async #accept(frame: Frame): Promise<void> {
        if (frame.replyTo !== undefined) {
            this.#acceptReply(frame);
            return;
        }
        if (frame.streamId !== undefined) {
            await this.#acceptStreamFrame(frame);
            return;
        }
        await this.#route(frame);
    }

    #acceptReply(frame: Frame): void {
        const pending = this.#pending;
        if (pending === undefined || frame.replyTo !== pending.id) {
            throw protocolFailure(`Unexpected replyTo ${frame.replyTo}.`);
        }
        if (pending.expectsStream) {
            if (frame.event.error === undefined && frame.streamId !== pending.id) {
                throw protocolFailure("Stream acknowledgement must carry streamId equal to the root request id.");
            }
            if (frame.event.error === undefined) {
                this.#clientStreamId = pending.id;
            }
        } else if (frame.streamId !== undefined) {
            throw protocolFailure("A normal reply must not establish a stream.");
        }
        this.#pending = undefined;
        pending.resolve(frame);
    }

    async #acceptStreamFrame(frame: Frame): Promise<void> {
        const serverStream = this.#serverStream;
        if (serverStream !== undefined && frame.streamId === serverStream.id) {
            await serverStream.options.onEvent?.(frame.event, frame);
            return;
        }

        if (this.#clientStreamId === undefined || frame.streamId !== this.#clientStreamId) {
            throw protocolFailure(`Unexpected streamId ${frame.streamId}.`);
        }

        const waiter = this.#streamWaiters.shift();
        if (waiter === undefined) {
            this.#streamFrames.push(frame);
        } else {
            waiter.resolve(frame);
        }

        if (frame.event.name === "stream.completed" || frame.event.name === "stream.cancelled") {
            this.#clientStreamEnded = true;
        }
    }

    async #route(frame: Frame): Promise<void> {
        if (this.#getSnapshot === undefined) {
            throw protocolFailure("This PrefixRoute has no route snapshot.");
        }
        if (this.#rootAccepted) {
            throw protocolFailure("A dedicated PrefixRoute connection accepts only one root request.");
        }
        if (frame.event.error !== undefined) {
            throw protocolFailure("A new routed request cannot carry an error.");
        }
        this.#rootAccepted = true;

        const [moduleName, operationName] = frame.event.name.split(".");
        const snapshot = this.#getSnapshot();
        const modules = snapshot.destinations.get(frame.event.destination);
        if (modules === undefined) {
            await this.#sendErrorReply(
                frame,
                createError({
                    code: errorCodes.targetInvalid,
                    message: `Destination ${frame.event.destination} was not found.`,
                    retryable: false
                }).toBody()
            );
            return;
        }
        const operations = modules.get(moduleName!);
        if (operations === undefined) {
            await this.#sendErrorReply(
                frame,
                createError({
                    code: errorCodes.envelopeInvalid,
                    message: `Module ${moduleName} was not found for ${frame.event.destination}.`,
                    retryable: false
                }).toBody()
            );
            return;
        }
        const handler = operations.get(operationName!);
        if (handler === undefined) {
            await this.#sendErrorReply(
                frame,
                createError({
                    code: errorCodes.envelopeInvalid,
                    message: `Operation ${frame.event.name} was not found for ${frame.event.destination}.`,
                    retryable: false
                }).toBody()
            );
            return;
        }

        const afterReply: Array<() => Promise<void> | void> = [];
        let openedStream: PrefixRouteStream | undefined;
        const context: PrefixRouteContext = {
            afterReply: (action) => {
                afterReply.push(action);
            },
            connectionId: this.#connectionId,
            destination: frame.event.destination,
            module: moduleName!,
            openStream: async (initialPayload, options = {}) => {
                if (openedStream !== undefined || this.#serverStream !== undefined) {
                    throw new Error("A dedicated PrefixRoute connection accepts only one stream.");
                }
                const active: ActiveServerStream = {
                    closed: false,
                    destination: frame.event.destination,
                    id: frame.id,
                    module: moduleName!,
                    options
                };
                this.#serverStream = active;
                openedStream = this.#createServerStream(active);
                await this.#codec.send({
                    id: this.#nextId(),
                    replyTo: frame.id,
                    streamId: frame.id,
                    event: {
                        destination: frame.event.destination,
                        name: frame.event.name,
                        ...(initialPayload === undefined ? {} : { payload: initialPayload })
                    }
                });
                return openedStream;
            },
            peer: frame.from as Exclude<Peer, "server">,
            requestId: frame.id,
            signal: this.#abortController.signal
        };

        try {
            const result = await handler({
                id: frame.id,
                name: operationName!,
                ...(frame.event.payload === undefined ? {} : { payload: frame.event.payload }),
                ...(frame.event.seq === undefined ? {} : { seq: frame.event.seq })
            }, context);
            if (openedStream === undefined) {
                await this.#codec.send({
                    id: this.#nextId(),
                    replyTo: frame.id,
                    event: {
                        destination: frame.event.destination,
                        name: frame.event.name,
                        ...(result === undefined ? {} : { payload: result })
                    }
                });
                for (const action of afterReply) {
                    queueMicrotask(() => {
                        void action();
                    });
                }
            }
        } catch (error) {
            const body = normalizeError(error);
            if (openedStream !== undefined) {
                await openedStream.cancel(body);
            } else {
                await this.#sendErrorReply(frame, body);
            }
        }
    }

    #createServerStream(active: ActiveServerStream): PrefixRouteStream {
        const sendTerminal = async (name: "stream.cancelled" | "stream.completed", payload?: JsonValue, error?: ControlErrorBody) => {
            if (active.closed) {
                return;
            }
            active.closed = true;
            await this.#codec.send({
                id: this.#nextId(),
                streamId: active.id,
                event: {
                    destination: active.destination,
                    name,
                    ...(payload === undefined ? {} : { payload }),
                    ...(error === undefined ? {} : { error })
                }
            });
            if (this.#serverStream === active) {
                this.#serverStream = undefined;
            }
        };

        return {
            id: active.id,
            cancel: async (error) => {
                await sendTerminal("stream.cancelled", undefined, error);
            },
            complete: async (payload) => {
                await sendTerminal("stream.completed", payload);
            },
            emit: async (name, payload, seq) => {
                if (active.closed) {
                    throw new Error(`Stream ${active.id} is closed.`);
                }
                const fullName = name.includes(".") ? name : `${active.module}.${name}`;
                await this.#codec.send({
                    id: this.#nextId(),
                    streamId: active.id,
                    event: {
                        destination: active.destination,
                        name: fullName as Event["name"],
                        ...(payload === undefined ? {} : { payload }),
                        ...(seq === undefined ? {} : { seq })
                    }
                });
            }
        };
    }

    async #sendErrorReply(frame: Frame, error: ControlErrorBody): Promise<void> {
        await this.#codec.send({
            id: this.#nextId(),
            replyTo: frame.id,
            event: {
                destination: frame.event.destination,
                name: frame.event.name,
                error
            }
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
        const failure = this.#closeError ?? new Error("PrefixRoute connection closed.");
        const pending = this.#pending;
        this.#pending = undefined;
        pending?.reject(failure);
        for (const waiter of this.#streamWaiters.splice(0)) {
            waiter.reject(failure);
        }
        const serverStream = this.#serverStream;
        this.#serverStream = undefined;
        if (serverStream !== undefined && !serverStream.closed) {
            serverStream.closed = true;
            void serverStream.options.onClose?.();
        }
    }

    #nextId(): string {
        return `${this.#requestIdPrefix}-${randomUUID()}`;
    }
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
    return createError({
        code: errorCodes.envelopeInvalid,
        message,
        retryable: false
    });
}
