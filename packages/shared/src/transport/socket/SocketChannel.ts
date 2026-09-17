import { createConnection, type Socket } from "node:net";
import type { Channel } from "../protocol/Channel.js";

export interface SocketChannelOptions {
    signal?: AbortSignal;
    socketFactory?: (path: string) => Socket;
}

export class SocketChannel implements Channel {
    readonly #socket: Socket;
    readonly #dataListeners = new Set<(data: Uint8Array) => void>();
    readonly #closeListeners = new Set<(error?: Error) => void>();
    #closed = false;
    #closeError?: Error;
    #closeNotified = false;
    #writeQueue: Promise<void> = Promise.resolve();

    static async connect(
        socketPath: string,
        options: SocketChannelOptions = {},
    ): Promise<SocketChannel> {
        if (options.signal?.aborted === true) {
            throw abortError(options.signal);
        }
        const socket =
            options.socketFactory?.(socketPath) ?? createConnection(socketPath);
        return await new Promise<SocketChannel>((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                options.signal?.removeEventListener("abort", onAbort);
                socket.off("connect", onConnect);
                socket.off("error", onError);
            };
            const onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                try {
                    socket.destroy();
                } catch {
                    // The aborted connection attempt is already rejected.
                }
                reject(abortError(options.signal!));
            };
            const onConnect = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(new SocketChannel(socket));
            };
            const onError = (error: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                try {
                    socket.destroy();
                } catch {
                    // The connection error already owns the rejection.
                }
                reject(error);
            };
            options.signal?.addEventListener("abort", onAbort, { once: true });
            socket.once("connect", onConnect);
            socket.once("error", onError);
            if (options.signal?.aborted === true) onAbort();
        });
    }

    static accept(
        socket: Socket,
        _options: Omit<SocketChannelOptions, "socketFactory"> = {},
    ): SocketChannel {
        return new SocketChannel(socket);
    }

    private constructor(socket: Socket) {
        this.#socket = socket;
        socket.on("data", (chunk: Buffer) => this.#acceptChunk(chunk));
        socket.once("end", () => this.close());
        socket.once("error", (error) => this.close(error));
        socket.once("close", () => this.#finishClose());
    }

    get closed(): boolean {
        return this.#closed;
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.#closed) {
            throw this.#closeError ?? new Error("Socket channel is closed.");
        }
        const copy = Uint8Array.from(data);
        const write = this.#writeQueue.then(async () => {
            if (this.#closed) {
                throw (
                    this.#closeError ?? new Error("Socket channel is closed.")
                );
            }
            await new Promise<void>((resolve, reject) => {
                try {
                    this.#socket.write(copy, (error) =>
                        error == null ? resolve() : reject(error),
                    );
                } catch (error) {
                    reject(error);
                }
            });
        });
        this.#writeQueue = write.catch(() => undefined);
        try {
            await write;
        } catch (error) {
            const normalized =
                error instanceof Error ? error : new Error(String(error));
            this.close(normalized);
            throw normalized;
        }
    }

    onData(listener: (data: Uint8Array) => void): () => void {
        this.#dataListeners.add(listener);
        return () => this.#dataListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        if (this.#closeNotified) {
            queueMicrotask(() => this.#notifyCloseListener(listener));
            return () => undefined;
        }
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    close(error?: Error): void {
        if (error !== undefined && this.#closeError === undefined) {
            this.#closeError = error;
        }
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#socket.destroy();
        this.#finishClose();
    }

    #acceptChunk(chunk: Buffer): void {
        if (this.#closed) {
            return;
        }
        for (const listener of [...this.#dataListeners]) {
            try {
                listener(Uint8Array.from(chunk));
            } catch (error) {
                process.emitWarning(
                    error instanceof Error ? error : new Error(String(error)),
                );
            }
        }
    }

    #finishClose(): void {
        if (this.#closeNotified) {
            return;
        }
        this.#closed = true;
        this.#closeNotified = true;
        const listeners = [...this.#closeListeners];
        this.#closeListeners.clear();
        for (const listener of listeners) {
            this.#notifyCloseListener(listener);
        }
    }

    #notifyCloseListener(listener: (error?: Error) => void): void {
        try {
            listener(this.#closeError);
        } catch (error) {
            process.emitWarning(
                error instanceof Error ? error : new Error(String(error)),
            );
        }
    }
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error("Socket channel connection was aborted.");
}
