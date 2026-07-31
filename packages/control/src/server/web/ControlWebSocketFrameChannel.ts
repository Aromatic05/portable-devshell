import type { FrameChannel } from "@portable-devshell/shared";
import WebSocket, { type RawData } from "ws";

const HEARTBEAT_INTERVAL_MS = 20_000;
const DEAD_CONNECTION_MS = 60_000;

export interface ControlWebSocketFrameChannelOptions {
    deadConnectionMs?: number;
    heartbeatIntervalMs?: number;
    now?: () => number;
}

export class ControlWebSocketFrameChannel implements FrameChannel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #frameListeners = new Set<(frame: Uint8Array) => void>();
    readonly #heartbeat: NodeJS.Timeout;
    readonly #deadConnectionMs: number;
    readonly #now: () => number;
    readonly #socket: WebSocket;
    #closed = false;
    #closeError?: Error;
    #lastSeenAt: number;
    #sendTail: Promise<void> = Promise.resolve();

    constructor(socket: WebSocket, options: ControlWebSocketFrameChannelOptions = {}) {
        this.#socket = socket;
        this.#deadConnectionMs = options.deadConnectionMs ?? DEAD_CONNECTION_MS;
        this.#now = options.now ?? Date.now;
        this.#lastSeenAt = this.#now();
        socket.on("message", this.#handleMessage);
        socket.on("pong", () => {
            this.#lastSeenAt = this.#now();
        });
        socket.once("error", (error) => this.#finish(error));
        socket.once("close", (code, reason) => {
            this.#finish(
                code === 1000
                    ? undefined
                    : new Error(`Control WebSocket closed: ${code} ${reason.toString()}`)
            );
        });
        this.#heartbeat = setInterval(
            () => this.#heartbeatTick(),
            options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
        );
        this.#heartbeat.unref();
    }

    get closed(): boolean {
        return this.#closed;
    }

    async send(frame: Uint8Array): Promise<void> {
        const copy = Uint8Array.from(frame);
        const operation = this.#sendTail.then(async () => {
            if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
                throw this.#closeError ?? new Error("Control WebSocket channel is closed.");
            }
            await new Promise<void>((resolve, reject) => {
                this.#socket.send(copy, { binary: true }, (error) => {
                    if (error == null) {
                        resolve();
                        return;
                    }
                    reject(error);
                });
            });
        });
        this.#sendTail = operation.catch(() => undefined);
        try {
            await operation;
        } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            if (!this.#closed) {
                this.#fail(normalized);
            }
            throw normalized;
        }
    }

    onFrame(listener: (frame: Uint8Array) => void): () => void {
        this.#frameListeners.add(listener);
        return () => this.#frameListeners.delete(listener);
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
        try {
            if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
                this.#socket.close(error === undefined ? 1000 : 1011, closeReason(error));
            }
        } catch (closeError) {
            this.#fail(closeError);
            return;
        }
        this.#finish(error);
    }

    readonly #handleMessage = (data: RawData, isBinary: boolean): void => {
        this.#lastSeenAt = this.#now();
        if (!isBinary) {
            this.#closeInvalid(
                1003,
                "binary RPC frame required",
                new Error("Control WebSocket requires binary RPC frames.")
            );
            return;
        }
        const frame = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data as ArrayBuffer);
        for (const listener of [...this.#frameListeners]) {
            try {
                listener(frame);
            } catch (error) {
                console.warn(error instanceof Error ? error : new Error(String(error)));
            }
        }
    };

    #heartbeatTick(): void {
        if (this.#closed) {
            return;
        }
        if (this.#now() - this.#lastSeenAt >= this.#deadConnectionMs) {
            this.#fail(new Error("Control WebSocket heartbeat timed out."));
            return;
        }
        if (this.#socket.readyState === WebSocket.OPEN) {
            try {
                this.#socket.ping();
            } catch (error) {
                this.#fail(error);
            }
        }
    }

    #fail(error: unknown): void {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.#finish(normalized);
        try {
            this.#socket.terminate();
        } catch {
            // The channel is already closed locally; transport teardown is best effort.
        }
    }

    #closeInvalid(code: number, reason: string, error: Error): void {
        try {
            this.#socket.close(code, reason);
        } catch {
            // The protocol error below owns the channel lifecycle.
        }
        this.#finish(error);
    }

    #finish(error?: Error): void {
        if (error !== undefined && this.#closeError === undefined) {
            this.#closeError = error;
        }
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        clearInterval(this.#heartbeat);
        const listeners = [...this.#closeListeners];
        this.#closeListeners.clear();
        this.#frameListeners.clear();
        for (const listener of listeners) {
            try {
                listener(this.#closeError);
            } catch (listenerError) {
                console.warn(listenerError instanceof Error ? listenerError : new Error(String(listenerError)));
            }
        }
    }
}

function closeReason(error: Error | undefined): string {
    return (error?.message ?? "channel closed").slice(0, 120);
}
