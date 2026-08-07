import type { Readable, Writable } from "node:stream";

import type { ErrorCode } from "../../error/ErrorCodeCatalog.js";
import { createError } from "../../error/ErrorFactoryCreate.js";
import { decodeFrame, encodeFrame, FrameBuffer, type Frame } from "./Frame.js";

export interface Channel {
    readonly closed: boolean;
    send(frame: Frame): Promise<void>;
    onFrame(listener: (frame: Frame) => void): () => void;
    onClose(listener: (error?: Error) => void): () => void;
    close(error?: Error): void;
}

export abstract class ChannelBase implements Channel {
    readonly #frameListeners = new Set<(frame: Frame) => void>();
    readonly #closeListeners = new Set<(error?: Error) => void>();
    #closed = false;
    #closeError?: Error;

    get closed(): boolean { return this.#closed; }

    onFrame(listener: (frame: Frame) => void): () => void {
        if (this.#closed) return () => undefined;
        this.#frameListeners.add(listener);
        return () => this.#frameListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        if (this.#closed) {
            queueMicrotask(() => this.#notify(listener));
            return () => undefined;
        }
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    protected emitFrame(frame: Frame): void {
        if (this.#closed) return;
        for (const listener of [...this.#frameListeners]) {
            try { listener(frame); } catch (error) { console.warn(asError(error)); }
        }
    }

    protected finish(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#closeError = error;
        this.#frameListeners.clear();
        const listeners = [...this.#closeListeners];
        this.#closeListeners.clear();
        for (const listener of listeners) this.#notify(listener);
    }

    protected closeError(fallback: string): Error {
        return this.#closeError ?? new Error(fallback);
    }

    #notify(listener: (error?: Error) => void): void {
        try { listener(this.#closeError); } catch (error) { console.warn(asError(error)); }
    }

    abstract send(frame: Frame): Promise<void>;
    abstract close(error?: Error): void;
}

export function asChannelError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export class FramedStreamChannel extends ChannelBase {
    readonly #frames = new FrameBuffer();
    readonly #readable: Readable;
    readonly #writable: Writable;
    readonly #closeTransport?: (error?: Error) => void;
    #writeTail: Promise<void> = Promise.resolve();

    constructor(readable: Readable, writable: Writable, options: { closeTransport?(error?: Error): void } = {}) {
        super();
        this.#readable = readable;
        this.#writable = writable;
        this.#closeTransport = options.closeTransport;
        readable.on("data", this.#data);
        readable.once("end", this.#end);
        readable.once("error", this.#error);
        writable.once("error", this.#error);
    }

    async send(frame: Frame): Promise<void> {
        if (this.closed) throw this.closeError("Stream channel is closed.");
        const encoded = encodeFrame(frame);
        const write = this.#writeTail.then(async () => {
            if (this.closed) throw this.closeError("Stream channel is closed.");
            await new Promise<void>((resolve, reject) => {
                try { this.#writable.write(encoded, (error) => error == null ? resolve() : reject(error)); }
                catch (error) { reject(error); }
            });
        });
        this.#writeTail = write.catch(() => undefined);
        try { await write; } catch (error) {
            const normalized = asChannelError(error);
            this.close(normalized);
            throw normalized;
        }
    }

    close(error?: Error): void {
        if (this.closed) return;
        let finalError = error;
        try { this.#closeTransport?.(error); } catch (closeError) { finalError ??= asChannelError(closeError); }
        this.#cleanup();
        this.#frames.reset();
        this.finish(finalError);
    }

    readonly #data = (chunk: Uint8Array): void => {
        try { for (const frame of this.#frames.push(chunk)) this.emitFrame(frame); }
        catch (error) { this.close(asChannelError(error)); }
    };
    readonly #end = (): void => {
        this.close(this.#frames.empty ? undefined : streamProtocolError("Stream ended with an incomplete frame."));
    };
    readonly #error = (error: Error): void => this.close(error);

    #cleanup(): void {
        this.#readable.off("data", this.#data);
        this.#readable.off("end", this.#end);
        this.#readable.off("error", this.#error);
        this.#writable.off("error", this.#error);
    }
}

function streamProtocolError(message: string): Error {
    return createError({ code: "protocol.invalidFrame" as ErrorCode, message, retryable: false });
}

export class LengthPrefixedChannel extends ChannelBase {
    readonly #inner: Channel;

    constructor(inner: Channel) {
        super();
        this.#inner = inner;
        inner.onFrame((frame) => {
            try { this.emitFrame(decodeFrame(frame)); }
            catch (error) { this.close(asChannelError(error)); }
        });
        inner.onClose((error) => this.finish(error));
    }

    async send(frame: Frame): Promise<void> {
        if (this.closed) throw this.closeError("Length-prefixed channel is closed.");
        await this.#inner.send(encodeFrame(frame));
    }

    close(error?: Error): void {
        if (this.closed) return;
        this.#inner.close(error);
        this.finish(error);
    }
}
