import { createConnection, type Socket } from "node:net";

import type { ErrorCode } from "../error/ErrorCodeCatalog.js";
import { createError } from "../error/ErrorFactoryCreate.js";

const HEADER_SIZE = 4;
export const CHANNEL_MAX_FRAME_SIZE = 16 * 1024 * 1024;

export interface ChannelOptions {
    maxFrameSize?: number;
    socketFactory?: (path: string) => Socket;
}

export class Channel {
    readonly #socket: Socket;
    readonly #maxFrameSize: number;
    readonly #frameListeners = new Set<(frame: Uint8Array) => void>();
    readonly #closeListeners = new Set<(error?: Error) => void>();
    #buffer = Buffer.alloc(0);
    #closed = false;
    #closeError?: Error;
    #closeNotified = false;
    #writeQueue: Promise<void> = Promise.resolve();

    static async connect(socketPath: string, options: ChannelOptions = {}): Promise<Channel> {
        const socket = options.socketFactory?.(socketPath) ?? createConnection(socketPath);

        return await new Promise<Channel>((resolve, reject) => {
            const onConnect = () => {
                const channel = new Channel(socket, options);
                socket.off("error", onError);
                resolve(channel);
            };
            const onError = (error: Error) => {
                socket.off("connect", onConnect);
                socket.destroy();
                reject(error);
            };

            socket.once("connect", onConnect);
            socket.once("error", onError);
        });
    }

    static accept(socket: Socket, options: Omit<ChannelOptions, "socketFactory"> = {}): Channel {
        return new Channel(socket, options);
    }

    private constructor(socket: Socket, options: Omit<ChannelOptions, "socketFactory">) {
        this.#socket = socket;
        this.#maxFrameSize = options.maxFrameSize ?? CHANNEL_MAX_FRAME_SIZE;

        socket.on("data", (chunk: Buffer) => {
            this.#acceptChunk(chunk);
        });
        socket.once("end", () => {
            if (this.#buffer.byteLength > 0) {
                this.close(protocolError("protocol.invalidFrame", "Socket ended with an incomplete frame."));
                return;
            }
            this.close();
        });
        socket.once("error", (error) => {
            this.close(error);
        });
        socket.once("close", () => {
            this.#finishClose();
        });
    }

    get closed(): boolean {
        return this.#closed;
    }

    async send(frame: Uint8Array): Promise<void> {
        if (this.#closed) {
            throw this.#closeError ?? new Error("Channel is closed.");
        }
        if (frame.byteLength > this.#maxFrameSize) {
            throw protocolError(
                "protocol.frameTooLarge",
                `Frame payload exceeds ${this.#maxFrameSize} bytes.`
            );
        }

        const payload = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
        const encoded = Buffer.allocUnsafe(HEADER_SIZE + payload.byteLength);
        encoded.writeUInt32BE(payload.byteLength, 0);
        payload.copy(encoded, HEADER_SIZE);

        const write = this.#writeQueue.then(async () => {
            if (this.#closed) {
                throw this.#closeError ?? new Error("Channel is closed.");
            }
            await new Promise<void>((resolve, reject) => {
                try {
                    this.#socket.write(encoded, (error) => {
                        if (error != null) {
                            reject(error);
                            return;
                        }
                        resolve();
                    });
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

    onFrame(listener: (frame: Uint8Array) => void): () => void {
        this.#frameListeners.add(listener);
        return () => {
            this.#frameListeners.delete(listener);
        };
    }

    onClose(listener: (error?: Error) => void): () => void {
        if (this.#closeNotified) {
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
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#buffer = Buffer.alloc(0);
        this.#socket.destroy();
        this.#finishClose();
    }

    #acceptChunk(chunk: Buffer): void {
        if (this.#closed || chunk.byteLength === 0) {
            return;
        }

        this.#buffer = this.#buffer.byteLength === 0
            ? Buffer.from(chunk)
            : Buffer.concat([this.#buffer, chunk]);

        try {
            while (this.#buffer.byteLength >= HEADER_SIZE) {
                const payloadLength = this.#buffer.readUInt32BE(0);
                if (payloadLength > this.#maxFrameSize) {
                    throw protocolError(
                        "protocol.frameTooLarge",
                        `Frame payload exceeds ${this.#maxFrameSize} bytes.`
                    );
                }

                const encodedLength = HEADER_SIZE + payloadLength;
                if (this.#buffer.byteLength < encodedLength) {
                    return;
                }

                const frame = Buffer.from(this.#buffer.subarray(HEADER_SIZE, encodedLength));
                this.#buffer = this.#buffer.subarray(encodedLength);
                this.#emitFrame(frame);
            }
        } catch (error) {
            this.close(error instanceof Error ? error : new Error(String(error)));
        }
    }

    #emitFrame(frame: Uint8Array): void {
        for (const listener of [...this.#frameListeners]) {
            try {
                listener(frame);
            } catch (error) {
                process.emitWarning(error instanceof Error ? error : new Error(String(error)));
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
            try {
                listener(this.#closeError);
            } catch (error) {
                process.emitWarning(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }
}

function protocolError(code: string, message: string): Error {
    return createError({
        code: code as ErrorCode,
        message,
        retryable: false
    });
}
