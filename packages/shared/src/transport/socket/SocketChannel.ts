import { createConnection, type Socket } from "node:net";

import type { ErrorCode } from "../../error/ErrorCodeCatalog.js";
import { createError } from "../../error/ErrorFactoryCreate.js";
import { encodeFrame, FrameBuffer, TRANSPORT_MAX_FRAME_SIZE, type Frame } from "../protocol/Frame.js";
import type { Channel } from "../protocol/Channel.js";

export const SOCKET_CHANNEL_MAX_FRAME_SIZE = TRANSPORT_MAX_FRAME_SIZE;

export interface SocketChannelOptions {
    maxFrameSize?: number;
    signal?: AbortSignal;
    socketFactory?: (path: string) => Socket;
}

export class SocketChannel implements Channel {
    readonly #socket: Socket;
    readonly #maxFrameSize: number;
    readonly #frames: FrameBuffer;
    readonly #frameListeners = new Set<(frame: Frame) => void>();
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
        const socket = options.socketFactory?.(socketPath) ?? createConnection(socketPath);
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
                resolve(
                    new SocketChannel(socket, {
                        maxFrameSize: options.maxFrameSize,
                    }),
                );
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
        options: Omit<SocketChannelOptions, "socketFactory"> = {},
    ): SocketChannel {
        return new SocketChannel(socket, options);
    }

    private constructor(
        socket: Socket,
        options: Omit<SocketChannelOptions, "socketFactory">,
    ) {
        this.#socket = socket;
        this.#maxFrameSize =
            options.maxFrameSize ?? SOCKET_CHANNEL_MAX_FRAME_SIZE;
        this.#frames = new FrameBuffer(this.#maxFrameSize);
        socket.on("data", (chunk: Buffer) => this.#acceptChunk(chunk));
        socket.once("end", () => {
            if (!this.#frames.empty) {
                this.close(protocolError("protocol.invalidFrame", "Socket ended with an incomplete frame."));
                return;
            }
            this.close();
        });
        socket.once("error", (error) => this.close(error));
        socket.once("close", () => this.#finishClose());
    }

    get closed(): boolean {
        return this.#closed;
    }

    async send(frame: Frame): Promise<void> {
        if (this.#closed) {
            throw this.#closeError ?? new Error("Socket channel is closed.");
        }
        const encoded = encodeFrame(frame, this.#maxFrameSize);
        const write = this.#writeQueue.then(async () => {
            if (this.#closed) {
                throw this.#closeError ?? new Error("Socket channel is closed.");
            }
            await new Promise<void>((resolve, reject) => {
                try {
                    this.#socket.write(encoded, (error) => error == null ? resolve() : reject(error));
                } catch (error) {
                    reject(error);
                }
            });
        });
        this.#writeQueue = write.catch(() => undefined);
        try {
            await write;
        } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            this.close(normalized);
            throw normalized;
        }
    }

    onFrame(listener: (frame: Frame) => void): () => void {
        this.#frameListeners.add(listener);
        return () => this.#frameListeners.delete(listener);
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
        this.#frames.reset();
        this.#socket.destroy();
        this.#finishClose();
    }

    #acceptChunk(chunk: Buffer): void {
        if (this.#closed) {
            return;
        }
        try {
            for (const frame of this.#frames.push(chunk)) {
                for (const listener of [...this.#frameListeners]) {
                    try {
                        listener(frame);
                    } catch (error) {
                        process.emitWarning(error instanceof Error ? error : new Error(String(error)));
                    }
                }
            }
        } catch (error) {
            this.close(error instanceof Error ? error : new Error(String(error)));
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
            process.emitWarning(error instanceof Error ? error : new Error(String(error)));
        }
    }
}

function protocolError(code: string, message: string): Error {
    return createError({ code: code as ErrorCode, message, retryable: false });
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error("Socket channel connection was aborted.");
}
