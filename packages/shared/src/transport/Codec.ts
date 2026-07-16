import { TextDecoder } from "node:util";

import { isControlErrorBody, type ControlErrorBody } from "../error/ErrorBodyControl.js";
import type { ErrorCode } from "../error/ErrorCodeCatalog.js";
import { createError } from "../error/ErrorFactoryCreate.js";
import type { JsonValue } from "../type/TypeJsonValue.js";
import type { InstanceName } from "../type/identity/TypeIdentityInstanceName.js";
import { Channel } from "./Channel.js";
import type { Frame } from "./Frame.js";

export type Peer = "cli" | "tui" | "server";
export type Destination = "@control" | InstanceName;

export interface Event {
    id: string;
    replyTo?: string;
    streamId?: string;
    from: Peer;
    to: Peer;
    destination: Destination;
    name: `${string}.${string}`;
    payload?: JsonValue;
    error?: ControlErrorBody;
    seq?: number;
}

export type EventInput = Omit<Event, "from" | "to">;

export interface CodecOptions {
    local: Peer;
    remote?: Peer;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

export class Codec {
    readonly #channel: Channel;
    readonly #local: Peer;
    readonly #eventListeners = new Set<(event: Event) => void>();
    readonly #closeListeners = new Set<(error?: Error) => void>();
    #remote?: Peer;
    #closed = false;
    #closeError?: Error;

    constructor(channel: Channel, options: CodecOptions) {
        this.#channel = channel;
        this.#local = options.local;
        this.#remote = options.remote;
        channel.onFrame((frame) => this.#accept(frame));
        channel.onClose((error) => this.#finishClose(error));
    }

    get localPeer(): Peer {
        return this.#local;
    }

    get remotePeer(): Peer | undefined {
        return this.#remote;
    }

    get closed(): boolean {
        return this.#closed;
    }

    async send(input: EventInput): Promise<void> {
        if (this.#closed) {
            throw this.#closeError ?? new Error("Codec is closed.");
        }
        if (this.#remote === undefined) {
            throw protocolError("protocol.invalidDirection", "Remote peer is not bound yet.");
        }
        const event = validateEvent({ ...input, from: this.#local, to: this.#remote });
        await this.#channel.send(Buffer.from(JSON.stringify(event), "utf8"));
    }

    onEvent(listener: (event: Event) => void): () => void {
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
        if (error !== undefined && this.#closeError === undefined) {
            this.#closeError = error;
        }
        this.#channel.close(error);
        this.#finishClose(error);
    }

    #accept(frame: Frame): void {
        if (this.#closed) {
            return;
        }
        try {
            const text = decoder.decode(frame);
            if (text.length === 0) {
                throw protocolError("protocol.invalidJson", "Frame payload must not be empty.");
            }
            const event = validateEvent(JSON.parse(text) as unknown);
            this.#bindDirection(event);
            for (const listener of [...this.#eventListeners]) {
                try {
                    listener(event);
                } catch (error) {
                    process.emitWarning(error instanceof Error ? error : new Error(String(error)));
                }
            }
        } catch (error) {
            this.close(error instanceof Error ? error : new Error(String(error)));
        }
    }

    #bindDirection(event: Event): void {
        if (event.to !== this.#local) {
            throw protocolError(
                "protocol.invalidDirection",
                `Event addressed to ${event.to} cannot be accepted by ${this.#local}.`
            );
        }
        if (event.from === this.#local) {
            throw protocolError("protocol.invalidDirection", "Event source and destination peers must differ.");
        }
        if (this.#remote === undefined) {
            if (this.#local === "server" && event.from !== "cli" && event.from !== "tui") {
                throw protocolError("protocol.invalidDirection", "Server connections only accept cli or tui peers.");
            }
            this.#remote = event.from;
            return;
        }
        if (event.from !== this.#remote) {
            throw protocolError(
                "protocol.invalidDirection",
                `Connection is bound to ${this.#remote}, not ${event.from}.`
            );
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
        const listeners = [...this.#closeListeners];
        this.#closeListeners.clear();
        for (const listener of listeners) {
            try {
                listener(this.#closeError);
            } catch (listenerError) {
                process.emitWarning(listenerError instanceof Error ? listenerError : new Error(String(listenerError)));
            }
        }
    }
}

export function validateEvent(value: unknown): Event {
    if (!isRecord(value)) {
        throw protocolError("protocol.invalidEvent", "Event must be an object.");
    }
    const id = readNonEmptyString(value.id, "Event id");
    const replyTo = readOptionalNonEmptyString(value.replyTo, "replyTo");
    const streamId = readOptionalNonEmptyString(value.streamId, "streamId");
    const from = readPeer(value.from, "from");
    const to = readPeer(value.to, "to");
    const destination = readNonEmptyString(value.destination, "Event destination") as Destination;
    const name = readNonEmptyString(value.name, "Event name");
    if (!/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(name)) {
        throw protocolError("protocol.invalidEvent", `Event name must be exactly module.operation: ${name}.`);
    }
    if (value.payload !== undefined && value.error !== undefined) {
        throw protocolError("protocol.invalidEvent", "Event payload and error are mutually exclusive.");
    }
    if (value.error !== undefined && replyTo === undefined && streamId === undefined) {
        throw protocolError("protocol.invalidEvent", "Error events require replyTo or streamId.");
    }
    if (value.error !== undefined && !isControlErrorBody(value.error)) {
        throw protocolError("protocol.invalidEvent", "Event error is invalid.");
    }
    const seq = value.seq;
    if (seq !== undefined && (!Number.isSafeInteger(seq) || (seq as number) < 0)) {
        throw protocolError("protocol.invalidEvent", "Event seq must be a non-negative safe integer.");
    }
    return {
        id,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(streamId === undefined ? {} : { streamId }),
        from,
        to,
        destination,
        name: name as Event["name"],
        ...(value.payload === undefined ? {} : { payload: value.payload as JsonValue }),
        ...(value.error === undefined ? {} : { error: value.error }),
        ...(seq === undefined ? {} : { seq: seq as number })
    };
}

function readPeer(value: unknown, field: string): Peer {
    if (value === "cli" || value === "tui" || value === "server") {
        return value;
    }
    throw protocolError("protocol.invalidDirection", `Event ${field} must be cli, tui, or server.`);
}

function readNonEmptyString(value: unknown, field: string): string {
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    throw protocolError("protocol.invalidEvent", `${field} must be a non-empty string.`);
}

function readOptionalNonEmptyString(value: unknown, field: string): string | undefined {
    return value === undefined ? undefined : readNonEmptyString(value, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(code: string, message: string): Error {
    return createError({ code: code as ErrorCode, message, retryable: false });
}
