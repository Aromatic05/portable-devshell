import {
    ChannelBase,
    asChannelError,
    type Channel,
} from "./Channel.js";

export interface WebSocketClientLike {
    binaryType: string;
    close(code?: number, reason?: string): void;
    readonly readyState: number;
    send(data: ArrayBufferView | ArrayBuffer): void;
    addEventListener(type: "open", listener: () => void): void;
    addEventListener(type: "error", listener: (event: unknown) => void): void;
    addEventListener(
        type: "close",
        listener: (event: { code?: number; reason?: string }) => void,
    ): void;
    addEventListener(
        type: "message",
        listener: (event: { data: unknown }) => void,
    ): void;
    removeEventListener(type: "open", listener: () => void): void;
    removeEventListener(
        type: "error",
        listener: (event: unknown) => void,
    ): void;
    removeEventListener(
        type: "close",
        listener: (event: { code?: number; reason?: string }) => void,
    ): void;
    removeEventListener(
        type: "message",
        listener: (event: { data: unknown }) => void,
    ): void;
}

export interface WebChannelConnectOptions {
    protocols?: readonly string[];
    url: string;
    webSocketFactory?: (
        url: string,
        protocols: string[],
    ) => WebSocketClientLike;
}

const CONNECTING = 0;
const OPEN = 1;

export class WebChannel implements Channel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #dataListeners = new Set<(data: Uint8Array) => void>();
    readonly #socket: WebSocketClientLike;
    #closed = false;
    #closeError?: Error;
    #messageTail: Promise<void> = Promise.resolve();
    #sendTail: Promise<void> = Promise.resolve();

    static async connect(
        options: WebChannelConnectOptions,
        signal?: AbortSignal,
    ): Promise<WebChannel> {
        if (signal?.aborted === true) throw abortError(signal);
        const protocols = [...(options.protocols ?? [])];
        const socket = (options.webSocketFactory ?? defaultWebSocketFactory)(
            options.url,
            protocols,
        );
        const channel = new WebChannel(socket);
        return await new Promise<WebChannel>((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                signal?.removeEventListener("abort", aborted);
                socket.removeEventListener("open", opened);
                socket.removeEventListener("error", failed);
                socket.removeEventListener("close", closed);
            };
            const finishFailure = (error: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                channel.close(error);
                reject(error);
            };
            const opened = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(channel);
            };
            const failed = () =>
                finishFailure(
                    new Error(
                        "WebSocket connection failed or was rejected.",
                    ),
                );
            const closed = (event: { code?: number; reason?: string }) =>
                finishFailure(
                    new Error(
                        `WebSocket closed during connect: ${event.code ?? 1006} ${event.reason ?? ""}`.trim(),
                    ),
                );
            const aborted = () => finishFailure(abortError(signal!));

            socket.addEventListener("open", opened);
            socket.addEventListener("error", failed);
            socket.addEventListener("close", closed);
            signal?.addEventListener("abort", aborted, { once: true });
            if (signal?.aborted === true) aborted();
        });
    }

    constructor(socket: WebSocketClientLike) {
        this.#socket = socket;
        socket.binaryType = "arraybuffer";
        socket.addEventListener("message", this.#accept);
        socket.addEventListener("error", this.#error);
        socket.addEventListener("close", this.#close);
    }

    get closed(): boolean {
        return this.#closed;
    }

    async write(data: Uint8Array): Promise<void> {
        const copy = Uint8Array.from(data);
        const operation = this.#sendTail.then(() => {
            if (this.#closed || this.#socket.readyState !== OPEN) {
                throw (
                    this.#closeError ??
                    new Error("WebSocket channel is closed.")
                );
            }
            this.#socket.send(copy);
        });
        this.#sendTail = operation.catch(() => undefined);
        try {
            await operation;
        } catch (error) {
            const normalized = asError(error);
            this.#finish(normalized);
            throw normalized;
        }
    }

    onData(listener: (data: Uint8Array) => void): () => void {
        this.#dataListeners.add(listener);
        return () => this.#dataListeners.delete(listener);
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
            if (
                this.#socket.readyState === OPEN ||
                this.#socket.readyState === CONNECTING
            ) {
                this.#socket.close(
                    error === undefined ? 1000 : 1011,
                    closeReason(error),
                );
            }
        } catch (closeError) {
            this.#finish(asError(closeError));
            return;
        }
        this.#finish(error);
    }

    readonly #accept = (event: { data: unknown }): void => {
        this.#messageTail = this.#messageTail
            .then(async () => {
                const data = await toBytes(event.data);
                if (this.#closed) return;
                for (const listener of [...this.#dataListeners]) {
                    try {
                        listener(data);
                    } catch (error) {
                        console.warn(asError(error));
                    }
                }
            })
            .catch((error: unknown) => this.#finish(asError(error)));
    };

    readonly #error = (): void => {
        this.#finish(new Error("WebSocket connection failed."));
    };

    readonly #close = (event: { code?: number; reason?: string }): void => {
        const code = event.code ?? 1006;
        this.#finish(
            code === 1000
                ? undefined
                : new Error(
                      `WebSocket closed: ${code} ${event.reason ?? ""}`.trim(),
                  ),
        );
    };

    #finish(error?: Error): void {
        if (error !== undefined && this.#closeError === undefined) {
            this.#closeError = error;
        }
        if (this.#closed) return;
        this.#closed = true;
        this.#socket.removeEventListener("message", this.#accept);
        this.#socket.removeEventListener("error", this.#error);
        this.#socket.removeEventListener("close", this.#close);
        const listeners = [...this.#closeListeners];
        this.#closeListeners.clear();
        this.#dataListeners.clear();
        for (const listener of listeners) {
            try {
                listener(this.#closeError);
            } catch (listenerError) {
                console.warn(asError(listenerError));
            }
        }
    }
}

function defaultWebSocketFactory(
    url: string,
    protocols: string[],
): WebSocketClientLike {
    const WebSocketConstructor = globalThis.WebSocket;
    if (WebSocketConstructor === undefined) {
        throw new Error(
            "This Node.js runtime does not provide a WebSocket client.",
        );
    }
    return new WebSocketConstructor(
        url,
        protocols,
    ) as unknown as WebSocketClientLike;
}

async function toBytes(value: unknown): Promise<Uint8Array> {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (
        typeof value === "object" &&
        value !== null &&
        "arrayBuffer" in value &&
        typeof value.arrayBuffer === "function"
    ) {
        return new Uint8Array(await value.arrayBuffer());
    }
    throw new Error("WebSocket channel requires binary frames.");
}

function closeReason(error: Error | undefined): string {
    return (error?.message ?? "channel closed").slice(0, 120);
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error("WebSocket connection was aborted.");
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

const SERVER_HEARTBEAT_INTERVAL_MS = 20_000;
const SERVER_DEAD_CONNECTION_MS = 60_000;

export interface WebSocketServerLike {
    readonly readyState: number;
    on(
        event: "message",
        listener: (data: unknown, isBinary: boolean) => void,
    ): unknown;
    on(event: "pong", listener: () => void): unknown;
    once(event: "error", listener: (error: Error) => void): unknown;
    once(
        event: "close",
        listener: (code: number, reason: Uint8Array) => void,
    ): unknown;
    send(
        data: Uint8Array,
        options: { binary: true },
        callback: (error?: Error) => void,
    ): void;
    close(code?: number, reason?: string): void;
    ping(): void;
    terminate(): void;
}

export interface WebServerChannelOptions {
    /** WSS v2 only: deduplicate acknowledged Worker result frames per instance. */
    /** Return a commit callback for a new frame, or undefined for a duplicate. */
    reliableFrames?: (session: string, seq: bigint) => (() => void) | undefined;
    deadConnectionMs?: number;
    heartbeatIntervalMs?: number;
    now?: () => number;
}

export class WebServerChannel extends ChannelBase {
    readonly #socket: WebSocketServerLike;
    readonly #reliableFrames?: WebServerChannelOptions["reliableFrames"];
    readonly #pendingReliableFrames: Uint8Array[] = [];
    #reliableSubscribed = false;
    readonly #deadConnectionMs: number;
    readonly #heartbeat: NodeJS.Timeout;
    readonly #now: () => number;
    #lastSeenAt: number;
    #sendTail: Promise<void> = Promise.resolve();

    constructor(
        socket: WebSocketServerLike,
        options: WebServerChannelOptions = {},
    ) {
        super();
        this.#socket = socket;
        this.#reliableFrames = options.reliableFrames;
        this.#deadConnectionMs =
            options.deadConnectionMs ?? SERVER_DEAD_CONNECTION_MS;
        this.#now = options.now ?? Date.now;
        this.#lastSeenAt = this.#now();
        socket.on("message", this.#message);
        socket.on("pong", () => {
            this.#lastSeenAt = this.#now();
        });
        socket.once("error", (error) => this.#fail(error));
        socket.once("close", (code, reason) => {
            clearInterval(this.#heartbeat);
            this.finish(
                code === 1000
                    ? undefined
                    : new Error(
                          `WebSocket closed: ${code} ${Buffer.from(reason).toString()}`.trim(),
                      ),
            );
        });
        this.#heartbeat = setInterval(
            () => this.#heartbeatTick(),
            options.heartbeatIntervalMs ?? SERVER_HEARTBEAT_INTERVAL_MS,
        );
        this.#heartbeat.unref();
    }

    override onData(listener: (data: Uint8Array) => void): () => void {
        const off = super.onData(listener);
        this.#reliableSubscribed = true;
        // Allow FrameProtocol to install onClose as well before admitting frames.
        queueMicrotask(() => this.#drainReliableFrames());
        return off;
    }

    async write(data: Uint8Array): Promise<void> {
        const copy = Uint8Array.from(data);
        const operation = this.#sendTail.then(async () => {
            if (this.closed || this.#socket.readyState !== OPEN)
                throw this.closeError("WebSocket channel is closed.");
            await new Promise<void>((resolve, reject) => {
                try {
                    this.#socket.send(copy, { binary: true }, (error) =>
                        error == null ? resolve() : reject(error),
                    );
                } catch (error) {
                    reject(error);
                }
            });
        });
        this.#sendTail = operation.catch(() => undefined);
        try {
            await operation;
        } catch (error) {
            const normalized = asChannelError(error);
            this.#fail(normalized);
            throw normalized;
        }
    }

    close(error?: Error): void {
        if (this.closed) return;
        try {
            if (
                this.#socket.readyState === OPEN ||
                this.#socket.readyState === CONNECTING
            ) {
                this.#socket.close(
                    error === undefined ? 1000 : 1011,
                    (error?.message ?? "channel closed").slice(0, 120),
                );
            }
        } catch (closeError) {
            this.#fail(closeError);
            return;
        }
        clearInterval(this.#heartbeat);
        this.finish(error);
    }

    readonly #message = (data: unknown, isBinary: boolean): void => {
        this.#lastSeenAt = this.#now();
        if (!isBinary) {
            try {
                this.#socket.close(1003, "binary frame required");
            } catch {
                // Transport teardown is best effort after a protocol violation.
            }
            clearInterval(this.#heartbeat);
            this.finish(new Error("WebSocket channel requires binary frames."));
            return;
        }
        try {
            const bytes = toServerBytes(data);
            if (this.#reliableFrames === undefined) {
                this.emitData(bytes);
                return;
            }
            // WSS can deliver bytes before FrameProtocol attaches onData.
            // Never ACK such frames without a consumer; queue a bounded copy.
            if (this.#pendingReliableFrames.length >= 64)
                throw new Error("Reverse frame admission queue exhausted.");
            this.#pendingReliableFrames.push(bytes);
            this.#drainReliableFrames();
        } catch (error) {
            this.#fail(error);
        }
    };

    #drainReliableFrames(): void {
        if (!this.#reliableSubscribed || this.closed ||
            this.#reliableFrames === undefined) return;
        try {
            while (this.#pendingReliableFrames.length > 0) {
                const bytes = this.#pendingReliableFrames[0]!;
                if (bytes.byteLength <= 28 ||
                    Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "DSR2")
                    throw new Error("Invalid acknowledged reverse frame.");
                const session = Buffer.from(bytes.subarray(4, 20)).toString("hex");
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                const seq = view.getBigUint64(20, false);
                if (seq === 0n) throw new Error("Reverse frame sequence must be positive.");
                const commit = this.#reliableFrames(session, seq);
                if (commit !== undefined) {
                    if (!this.emitData(bytes.subarray(28)))
                        throw new Error("Reverse frame delivery was not accepted.");
                    commit();
                }
                this.#pendingReliableFrames.shift();
                const sendText = this.#socket as WebSocketServerLike & {
                    send(data: string, options: { binary: false }, callback: (error?: Error) => void): void;
                };
                sendText.send("DSR2:" + session + ":" + seq.toString(),
                    { binary: false }, (error) => {
                        if (error != null) this.#fail(error);
                    });
            }
        } catch (error) {
            this.#fail(error);
        }
    }

    #heartbeatTick(): void {
        if (this.closed) return;
        if (this.#now() - this.#lastSeenAt >= this.#deadConnectionMs) {
            this.#fail(new Error("WebSocket heartbeat timed out."));
            return;
        }
        if (this.#socket.readyState === OPEN) {
            try {
                this.#socket.ping();
            } catch (error) {
                this.#fail(error);
            }
        }
    }

    #fail(error: unknown): void {
        if (this.closed) return;
        clearInterval(this.#heartbeat);
        this.finish(asChannelError(error));
        try {
            this.#socket.terminate();
        } catch {
            // The channel is already failed; transport teardown is best effort.
        }
    }
}

function toServerBytes(data: unknown): Uint8Array {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data))
        return Buffer.concat(data.map((value) => Buffer.from(value)));
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data))
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new Error("WebSocket binary frame has an unsupported payload type.");
}
