import { Connection, Port } from "../endpoint/route/Route.js";
import { createTransportId, type Address } from "../endpoint/Address.js";
import type { Message } from "./Packet.js";

export interface StreamError {
    readonly message: string;
    readonly code?: string;
    readonly details?: unknown;
    readonly retryable?: boolean;
}

export type StreamRead =
    | { readonly type: "data"; readonly bytes?: Uint8Array; readonly message?: Message; readonly seq: number }
    | { readonly type: "fin" }
    | { readonly type: "close"; readonly message?: Message };

type StreamPacket =
    | { protocol: "stream"; type: "open"; id: string; name: string; message?: Message }
    | { protocol: "stream"; type: "data"; id: string; seq: number; bytes?: Uint8Array; message?: Message }
    | { protocol: "stream"; type: "fin"; id: string }
    | { protocol: "stream"; type: "close"; id: string; message?: Message }
    | { protocol: "stream"; type: "cancel"; id: string; error?: StreamError };

const BINARY_CHUNK_SIZE = 64 * 1024;

export class Stream {
    readonly #target: Connection | Port;
    readonly #streams = new Map<string, MessageStream>();
    readonly #openListeners = new Set<
        (
            stream: MessageStream,
            name: string,
            message: Message | undefined,
            peer: Address,
            local: Address,
        ) => Promise<void> | void
    >();
    readonly #unsubscribe: () => void;

    constructor(target: Connection | Port) {
        this.#target = target;
        if (target instanceof Connection) {
            const offPacket = target.onPacket((packet) =>
                this.#accept(packet, target.remote, target.local),
            );
            const offClose = target.onClose((error) =>
                this.#disconnect(error),
            );
            this.#unsubscribe = () => {
                offPacket();
                offClose();
            };
        } else {
            this.#unsubscribe = target.onPacket((packet, peer, local) =>
                this.#accept(packet, peer, local),
            );
        }
    }

    async open(name: string, message?: Message): Promise<MessageStream> {
        if (!(this.#target instanceof Connection))
            throw new Error("Stream open requires a Connection.");
        const connection = this.#target;
        const id = createTransportId();
        const stream = this.#create(
            id,
            connection.remote,
            connection.local,
            connection,
        );
        await connection.send({
            protocol: "stream",
            type: "open",
            id,
            name,
            ...(message === undefined ? {} : { message }),
        } satisfies StreamPacket);
        return stream;
    }

    onOpen(
        listener: (
            stream: MessageStream,
            name: string,
            message: Message | undefined,
            peer: Address,
            local: Address,
        ) => Promise<void> | void,
    ): () => void {
        this.#openListeners.add(listener);
        return () => this.#openListeners.delete(listener);
    }

    close(): void {
        this.#unsubscribe();
        for (const stream of this.#streams.values()) stream.dispose();
        this.#streams.clear();
        this.#openListeners.clear();
    }

    #disconnect(error?: Error): void {
        const failure: StreamError = {
            message: error?.message ?? "Stream connection closed.",
        };
        for (const stream of [...this.#streams.values()])
            stream.acceptCancel(failure);
        this.#streams.clear();
    }

    async #accept(value: unknown, peer: Address, local: Address): Promise<void> {
        const packet = parse(value);
        if (packet === undefined) return;
        const key = streamKey(local, peer, packet.id);
        if (packet.type === "open") {
            const connection =
                this.#target instanceof Connection
                    ? this.#target
                    : this.#target.connect(peer.host, peer.port, local);
            const stream = this.#create(packet.id, peer, local, connection);
            for (const listener of this.#openListeners)
                await listener(stream, packet.name, packet.message, peer, local);
            return;
        }
        const stream = this.#streams.get(key);
        if (stream === undefined) return;
        if (packet.type === "data") {
            await stream.acceptData(packet.seq, packet.message, packet.bytes);
            return;
        }
        if (packet.type === "fin") {
            stream.acceptFin();
            return;
        }
        this.#streams.delete(key);
        if (packet.type === "cancel") stream.acceptCancel(packet.error);
        else stream.acceptClose(packet.message);
    }

    #create(
        id: string,
        peer: Address,
        local: Address,
        connection: Connection,
    ): MessageStream {
        const key = streamKey(local, peer, id);
        const stream = new MessageStream(id, connection, () =>
            this.#streams.delete(key),
        );
        this.#streams.set(key, stream);
        return stream;
    }
}

function streamKey(local: Address, peer: Address, id: string): string {
    return `${local.host}\u0000${local.port}\u0000${peer.host}\u0000${peer.port}\u0000${id}`;
}

export class MessageStream {
    readonly id: string;
    readonly #connection: Connection;
    readonly #finish: () => void;
    readonly #dataListeners = new Set<
        (message: Message | undefined, seq: number) => Promise<void> | void
    >();
    readonly #closeListeners = new Set<(message?: Message) => void>();
    readonly #cancelListeners = new Set<(error?: StreamError) => void>();
    readonly #pending: Array<{ bytes?: Uint8Array; message?: Message; seq: number }> = [];
    readonly #readers: Array<{
        resolve(value: StreamRead): void;
        reject(error: Error): void;
    }> = [];
    #closed = false;
    #localFinished = false;
    #recvSeq = 0;
    #remoteFinished = false;
    #sendSeq = 0;
    #terminal?:
        | { type: "close"; message?: Message }
        | { type: "cancel"; error?: StreamError };

    constructor(id: string, connection: Connection, finish: () => void) {
        this.id = id;
        this.#connection = connection;
        this.#finish = finish;
    }

    async readMessage(): Promise<StreamRead> {
        const pending = this.#pending.shift();
        if (pending !== undefined) return { type: "data", ...pending };
        if (this.#terminal?.type === "close")
            return {
                type: "close",
                ...(this.#terminal.message === undefined
                    ? {}
                    : { message: this.#terminal.message }),
            };
        if (this.#terminal?.type === "cancel")
            throw streamError(this.#terminal.error);
        if (this.#remoteFinished) return { type: "fin" };
        return await new Promise((resolve, reject) =>
            this.#readers.push({ resolve, reject }),
        );
    }

    async read(): Promise<Uint8Array | undefined> {
        const next = await this.readMessage();
        if (next.type === "close" || next.type === "fin") return undefined;
        if (next.bytes === undefined)
            throw new Error("Stream byte packet is invalid.");
        return next.bytes;
    }

    send(message?: Message): Promise<void> {
        if (this.#closed || this.#localFinished)
            throw new Error("Stream write side is closed.");
        return this.#connection.send({
            protocol: "stream",
            type: "data",
            id: this.id,
            seq: ++this.#sendSeq,
            ...(message === undefined ? {} : { message }),
        } satisfies StreamPacket);
    }

    async write(data: Uint8Array): Promise<void> {
        if (data.byteLength === 0) {
            await this.#sendBytes(data);
            return;
        }
        for (let offset = 0; offset < data.byteLength; offset += BINARY_CHUNK_SIZE)
            await this.#sendBytes(
                data.subarray(
                    offset,
                    Math.min(offset + BINARY_CHUNK_SIZE, data.byteLength),
                ),
            );
    }

    async finish(): Promise<void> {
        if (this.#closed || this.#localFinished) return;
        this.#localFinished = true;
        if (!this.#connection.connected) return;
        await this.#connection.send({
            protocol: "stream",
            type: "fin",
            id: this.id,
        } satisfies StreamPacket);
    }

    async close(message?: Message): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        try {
            if (this.#connection.connected)
                await this.#connection.send({
                    protocol: "stream",
                    type: "close",
                    id: this.id,
                    ...(message === undefined ? {} : { message }),
                } satisfies StreamPacket);
        } catch (error) {
            if (this.#connection.connected) throw error;
        } finally {
            this.#finish();
        }
    }

    async cancel(error?: StreamError): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        try {
            if (this.#connection.connected)
                await this.#connection.send({
                    protocol: "stream",
                    type: "cancel",
                    id: this.id,
                    ...(error === undefined ? {} : { error }),
                } satisfies StreamPacket);
        } catch (cause) {
            if (this.#connection.connected) throw cause;
        } finally {
            this.#finish();
        }
    }

    onData(
        listener: (
            message: Message | undefined,
            seq: number,
        ) => Promise<void> | void,
    ): () => void {
        this.#dataListeners.add(listener);
        const pending: Array<{ message: Message | undefined; seq: number }> = [];
        for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
            const item = this.#pending[index]!;
            if (item.bytes !== undefined) continue;
            this.#pending.splice(index, 1);
            pending.unshift({ message: item.message, seq: item.seq });
        }
        if (pending.length > 0)
            queueMicrotask(() => {
                void (async () => {
                    for (const item of pending)
                        await listener(item.message, item.seq);
                })();
            });
        return () => this.#dataListeners.delete(listener);
    }

    onClose(listener: (message?: Message) => void): () => void {
        if (this.#terminal?.type === "close") {
            const message = this.#terminal.message;
            queueMicrotask(() => listener(message));
            return () => undefined;
        }
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    onCancel(listener: (error?: StreamError) => void): () => void {
        if (this.#terminal?.type === "cancel") {
            const error = this.#terminal.error;
            queueMicrotask(() => listener(error));
            return () => undefined;
        }
        this.#cancelListeners.add(listener);
        return () => this.#cancelListeners.delete(listener);
    }

    async acceptData(
        seq: number,
        message?: Message,
        bytes?: Uint8Array,
    ): Promise<void> {
        if (this.#closed) return;
        if (this.#remoteFinished)
            throw new Error(`Stream ${this.id} received DATA after FIN.`);
        if (seq !== this.#recvSeq + 1)
            throw new Error(
                `Stream ${this.id} expected seq ${this.#recvSeq + 1}, received ${seq}.`,
            );
        this.#recvSeq = seq;
        const data = {
            ...(bytes === undefined ? {} : { bytes }),
            ...(message === undefined ? {} : { message }),
            seq,
        };
        const reader = this.#readers.shift();
        if (reader !== undefined) {
            reader.resolve({ type: "data", ...data });
            return;
        }
        if (bytes !== undefined || this.#dataListeners.size === 0) {
            this.#pending.push(data);
            return;
        }
        for (const listener of this.#dataListeners) await listener(message, seq);
    }

    #sendBytes(bytes: Uint8Array): Promise<void> {
        if (this.#closed || this.#localFinished)
            throw new Error("Stream write side is closed.");
        return this.#connection.send({
            protocol: "stream",
            type: "data",
            id: this.id,
            seq: ++this.#sendSeq,
            bytes,
        } satisfies StreamPacket);
    }

    acceptFin(): void {
        if (this.#closed || this.#remoteFinished) return;
        this.#remoteFinished = true;
        for (const reader of this.#readers.splice(0))
            reader.resolve({ type: "fin" });
    }

    acceptClose(message?: Message): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#terminal = { type: "close", ...(message === undefined ? {} : { message }) };
        for (const reader of this.#readers.splice(0))
            reader.resolve({ type: "close", ...(message === undefined ? {} : { message }) });
        for (const listener of this.#closeListeners) listener(message);
        this.#finish();
    }

    acceptCancel(error?: StreamError): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#terminal = { type: "cancel", ...(error === undefined ? {} : { error }) };
        for (const reader of this.#readers.splice(0)) reader.reject(streamError(error));
        for (const listener of this.#cancelListeners) listener(error);
        this.#finish();
    }

    dispose(): void {
        this.#closed = true;
        this.#pending.length = 0;
        this.#readers.length = 0;
        this.#finish();
    }
}

function streamError(error?: StreamError): Error {
    return Object.assign(new Error(error?.message ?? "Stream cancelled."), {
        ...(error?.code === undefined ? {} : { code: error.code }),
        ...(error?.details === undefined ? {} : { details: error.details }),
        ...(error?.retryable === undefined ? {} : { retryable: error.retryable }),
    });
}

function parse(value: unknown): StreamPacket | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const packet = value as Record<string, unknown>;
    if (packet.protocol !== "stream") return undefined;
    if (typeof packet.id !== "string" || typeof packet.type !== "string")
        throw new Error("Invalid Stream packet.");
    if (packet.type === "open" && typeof packet.name === "string")
        return {
            protocol: "stream",
            type: "open",
            id: packet.id,
            name: packet.name,
            ...(packet.message === undefined ? {} : { message: packet.message }),
        };
    if (
        packet.type === "data" &&
        typeof packet.seq === "number" &&
        Number.isSafeInteger(packet.seq)
    ) {
        if (packet.bytes !== undefined && !(packet.bytes instanceof Uint8Array))
            throw new Error("Invalid Stream packet.");
        if (packet.bytes !== undefined && packet.message !== undefined)
            throw new Error("Invalid Stream packet.");
        return {
            protocol: "stream",
            type: "data",
            id: packet.id,
            seq: packet.seq,
            ...(packet.bytes === undefined ? {} : { bytes: packet.bytes }),
            ...(packet.message === undefined ? {} : { message: packet.message }),
        };
    }
    if (packet.type === "close")
        return {
            protocol: "stream",
            type: "close",
            id: packet.id,
            ...(packet.message === undefined ? {} : { message: packet.message }),
        };
    if (packet.type === "fin")
        return {
            protocol: "stream",
            type: "fin",
            id: packet.id,
        };
    if (packet.type === "cancel")
        return {
            protocol: "stream",
            type: "cancel",
            id: packet.id,
            ...(packet.error === undefined ? {} : { error: packet.error as StreamError }),
        };
    throw new Error("Invalid Stream packet.");
}
