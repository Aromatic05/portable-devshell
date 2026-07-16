import { TextDecoder } from "node:util";

import type { ControlErrorBody } from "../error/ErrorBodyControl.js";
import type { ErrorCode } from "../error/ErrorCodeCatalog.js";
import { createError } from "../error/ErrorFactoryCreate.js";
import type { JsonValue } from "../type/TypeJsonValue.js";
import type { InstanceName } from "../type/identity/TypeIdentityInstanceName.js";
import { Channel } from "./Channel.js";

export type Peer = "cli" | "tui" | "server";
export type Destination = "@control" | InstanceName;

export interface Event {
    destination: Destination;
    name: `${string}.${string}`;
    payload?: JsonValue;
    error?: ControlErrorBody;
    seq?: number;
}

export interface Frame {
    id: string;
    replyTo?: string;
    streamId?: string;
    from: Peer;
    to: Peer;
    event: Event;
}

export type FrameInput = Omit<Frame, "from" | "to">;

export interface CodecOptions {
    local: Peer;
    remote?: Peer;
}

export class Codec {
    readonly #channel: Channel;
    readonly #local: Peer;
    readonly #frameListeners = new Set<(frame: Frame) => void>();
    readonly #closeListeners = new Set<(error?: Error) => void>();
    #remote?: Peer;
    #closed = false;
    #closeError?: Error;

    constructor(channel: Channel, options: CodecOptions) {
        this.#channel = channel;
        this.#local = options.local;
        this.#remote = options.remote;

        channel.onFrame((payload) => {
            this.#accept(payload);
        });
        channel.onClose((error) => {
            this.#finishClose(error);
        });
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

    async send(input: FrameInput): Promise<void> {
        if (this.#closed) {
            throw this.#closeError ?? new Error("Codec is closed.");
        }
        if (this.#remote === undefined) {
            throw protocolError("protocol.invalidDirection", "Remote peer is not bound yet.");
        }

        const frame: Frame = {
            ...input,
            from: this.#local,
            to: this.#remote
        };
        validateFrame(frame);
        await this.#channel.send(Buffer.from(JSON.stringify(frame), "utf8"));
    }

    onFrame(listener: (frame: Frame) => void): () => void {
        this.#frameListeners.add(listener);
        return () => {
            this.#frameListeners.delete(listener);
        };
    }

    onClose(listener: (error?: Error) => void): () => void {
        if (this.#closed) {
            queueMicrotask(() => listener(this.#closeError));
            return () => undefined;
        }
        this.#closeListeners.add(listener);
        return () => {
            this.#closeListeners.delete(listener);
        };
    }

    close(error?: Error): void {
        if (error !== undefined && this.#closeError === undefined) {
            this.#closeError = error;
        }
        this.#channel.close(error);
        this.#finishClose(error);
    }

    #accept(payload: Uint8Array): void {
        if (this.#closed) {
            return;
        }

        try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
            if (text.length === 0) {
                throw protocolError("protocol.invalidJson", "Frame payload must not be empty.");
            }
            const frame = validateFrame(JSON.parse(text) as unknown);
            this.#bindDirection(frame);
            this.#emitFrame(frame);
        } catch (error) {
            this.close(error instanceof Error ? error : new Error(String(error)));
        }
    }

    #bindDirection(frame: Frame): void {
        if (frame.to !== this.#local) {
            throw protocolError(
                "protocol.invalidDirection",
                `Frame addressed to ${frame.to} cannot be accepted by ${this.#local}.`
            );
        }
        if (frame.from === this.#local) {
            throw protocolError("protocol.invalidDirection", "Frame source and destination peers must differ.");
        }

        if (this.#remote === undefined) {
            if (this.#local === "server" && frame.from !== "cli" && frame.from !== "tui") {
                throw protocolError("protocol.invalidDirection", "Server connections only accept cli or tui peers.");
            }
            this.#remote = frame.from;
            return;
        }

        if (frame.from !== this.#remote) {
            throw protocolError(
                "protocol.invalidDirection",
                `Connection is bound to ${this.#remote}, not ${frame.from}.`
            );
        }
    }

    #emitFrame(frame: Frame): void {
        for (const listener of [...this.#frameListeners]) {
            try {
                listener(frame);
            } catch (error) {
                process.emitWarning(error instanceof Error ? error : new Error(String(error)));
            }
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

export function validateFrame(value: unknown): Frame {
    if (!isRecord(value)) {
        throw protocolError("protocol.invalidFrame", "Frame must be an object.");
    }

    const id = readNonEmptyString(value.id, "Frame id");
    const replyTo = readOptionalNonEmptyString(value.replyTo, "replyTo");
    const streamId = readOptionalNonEmptyString(value.streamId, "streamId");
    const from = readPeer(value.from, "from");
    const to = readPeer(value.to, "to");
    const event = validateEvent(value.event, replyTo, streamId);

    return {
        id,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(streamId === undefined ? {} : { streamId }),
        from,
        to,
        event
    };
}

function validateEvent(value: unknown, replyTo?: string, streamId?: string): Event {
    if (!isRecord(value)) {
        throw protocolError("protocol.invalidEvent", "Frame event must be an object.");
    }

    const destinationValue = readNonEmptyString(value.destination, "Event destination");
    const nameValue = readNonEmptyString(value.name, "Event name");
    if (!/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(nameValue)) {
        throw protocolError("protocol.invalidEvent", `Event name must be exactly module.operation: ${nameValue}.`);
    }

    if (value.payload !== undefined && value.error !== undefined) {
        throw protocolError("protocol.invalidEvent", "Event payload and error are mutually exclusive.");
    }
    if (value.error !== undefined && replyTo === undefined && streamId === undefined) {
        throw protocolError("protocol.invalidEvent", "Error events require replyTo or streamId.");
    }

    const error = value.error === undefined ? undefined : validateErrorBody(value.error);
    const seq = value.seq;
    if (seq !== undefined && (!Number.isSafeInteger(seq) || (seq as number) < 0)) {
        throw protocolError("protocol.invalidEvent", "Event seq must be a non-negative safe integer.");
    }

    return {
        destination: destinationValue as Destination,
        name: nameValue as Event["name"],
        ...(value.payload === undefined ? {} : { payload: value.payload as JsonValue }),
        ...(error === undefined ? {} : { error }),
        ...(seq === undefined ? {} : { seq: seq as number })
    };
}

function validateErrorBody(value: unknown): ControlErrorBody {
    if (!isRecord(value)) {
        throw protocolError("protocol.invalidEvent", "Event error must be an object.");
    }
    if (typeof value.code !== "string" || value.code.length === 0) {
        throw protocolError("protocol.invalidEvent", "Event error code must be a non-empty string.");
    }
    if (typeof value.message !== "string" || value.message.length === 0) {
        throw protocolError("protocol.invalidEvent", "Event error message must be a non-empty string.");
    }
    if (typeof value.retryable !== "boolean") {
        throw protocolError("protocol.invalidEvent", "Event error retryable must be a boolean.");
    }
    return value as unknown as ControlErrorBody;
}

function readPeer(value: unknown, field: string): Peer {
    if (value === "cli" || value === "tui" || value === "server") {
        return value;
    }
    throw protocolError("protocol.invalidDirection", `Frame ${field} must be cli, tui, or server.`);
}

function readNonEmptyString(value: unknown, field: string): string {
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    throw protocolError("protocol.invalidFrame", `${field} must be a non-empty string.`);
}

function readOptionalNonEmptyString(value: unknown, field: string): string | undefined {
    return value === undefined ? undefined : readNonEmptyString(value, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(code: string, message: string): Error {
    return createError({
        code: code as ErrorCode,
        message,
        retryable: false
    });
}
