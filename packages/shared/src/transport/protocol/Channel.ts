import type { Readable, Writable } from "node:stream";

export interface Channel {
    readonly closed: boolean;
    write(data: Uint8Array): Promise<void>;
    onData(listener: (data: Uint8Array) => void): () => void;
    onClose(listener: (error?: Error) => void): () => void;
    close(error?: Error): void;
}

export abstract class ChannelBase implements Channel {
    readonly #dataListeners = new Set<(data: Uint8Array) => void>();
    readonly #closeListeners = new Set<(error?: Error) => void>();
    #closed = false;
    #closeError?: Error;

    get closed(): boolean {
        return this.#closed;
    }

    onData(listener: (data: Uint8Array) => void): () => void {
        if (this.#closed) return () => undefined;
        this.#dataListeners.add(listener);
        return () => this.#dataListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        if (this.#closed) {
            queueMicrotask(() => this.#notify(listener));
            return () => undefined;
        }
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    protected emitData(data: Uint8Array): void {
        if (this.#closed) return;
        for (const listener of [...this.#dataListeners]) {
            try {
                listener(data);
            } catch (error) {
                console.warn(asError(error));
            }
        }
    }

    protected finish(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#closeError = error;
        this.#dataListeners.clear();
        const listeners = [...this.#closeListeners];
        this.#closeListeners.clear();
        for (const listener of listeners) this.#notify(listener);
    }

    protected closeError(fallback: string): Error {
        return this.#closeError ?? new Error(fallback);
    }

    #notify(listener: (error?: Error) => void): void {
        try {
            listener(this.#closeError);
        } catch (error) {
            console.warn(asError(error));
        }
    }

    abstract write(data: Uint8Array): Promise<void>;
    abstract close(error?: Error): void;
}

export function asChannelError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export class StreamChannel extends ChannelBase {
    readonly #readable: Readable;
    readonly #writable: Writable;
    readonly #closeTransport?: (error?: Error) => void;
    #writeTail: Promise<void> = Promise.resolve();

    constructor(
        readable: Readable,
        writable: Writable,
        options: { closeTransport?(error?: Error): void } = {},
    ) {
        super();
        this.#readable = readable;
        this.#writable = writable;
        this.#closeTransport = options.closeTransport;
        readable.on("data", this.#data);
        readable.once("end", this.#end);
        readable.once("error", this.#error);
        writable.once("error", this.#error);
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.closed) throw this.closeError("Stream channel is closed.");
        const copy = Uint8Array.from(data);
        const write = this.#writeTail.then(async () => {
            if (this.closed) throw this.closeError("Stream channel is closed.");
            await new Promise<void>((resolve, reject) => {
                try {
                    this.#writable.write(copy, (error) =>
                        error == null ? resolve() : reject(error),
                    );
                } catch (error) {
                    reject(error);
                }
            });
        });
        this.#writeTail = write.catch(() => undefined);
        try {
            await write;
        } catch (error) {
            const normalized = asChannelError(error);
            this.close(normalized);
            throw normalized;
        }
    }

    close(error?: Error): void {
        if (this.closed) return;
        let finalError = error;
        try {
            this.#closeTransport?.(error);
        } catch (closeError) {
            finalError ??= asChannelError(closeError);
        }
        this.#cleanup();
        this.finish(finalError);
    }

    readonly #data = (chunk: Uint8Array): void => {
        this.emitData(Uint8Array.from(chunk));
    };
    readonly #end = (): void => this.close();
    readonly #error = (error: Error): void => this.close(error);

    #cleanup(): void {
        this.#readable.off("data", this.#data);
        this.#readable.off("end", this.#end);
        this.#readable.off("error", this.#error);
        this.#writable.off("error", this.#error);
    }
}
