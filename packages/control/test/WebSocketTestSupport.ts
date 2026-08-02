import type { FrameChannel } from "@portable-devshell/shared";
import WebSocket, { type RawData } from "ws";

export class NodeWebSocketFrameChannel implements FrameChannel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #frameListeners = new Set<(frame: Uint8Array) => void>();
    readonly #socket: WebSocket;
    #closed = false;
    #closeError?: Error;

    private constructor(socket: WebSocket) {
        this.#socket = socket;
        socket.on("message", (data, isBinary) => this.#accept(data, isBinary));
        socket.once("error", (error) => this.#finish(error));
        socket.once("close", (code, reason) => {
            this.#finish(code === 1000 ? undefined : new Error(`WebSocket closed: ${code} ${reason.toString()}`));
        });
    }

    static async connect(url: string, cookie: string): Promise<NodeWebSocketFrameChannel> {
        const socket = new WebSocket(url, "devshell-control-rpc.v1", {
            headers: { cookie }
        });
        await new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
        });
        return new NodeWebSocketFrameChannel(socket);
    }

    get closed(): boolean {
        return this.#closed;
    }

    async send(frame: Uint8Array): Promise<void> {
        if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
            throw this.#closeError ?? new Error("WebSocket channel is closed.");
        }
        await new Promise<void>((resolve, reject) => {
            this.#socket.send(frame, { binary: true }, (error) => error == null ? resolve() : reject(error));
        });
    }

    onFrame(listener: (frame: Uint8Array) => void): () => void {
        this.#frameListeners.add(listener);
        return () => this.#frameListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    close(error?: Error): void {
        if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
            this.#socket.close(1000, "client closed");
        }
        this.#finish(error);
    }

    #accept(data: RawData, isBinary: boolean): void {
        if (!isBinary) {
            this.#finish(new Error("Expected binary WebSocket frame."));
            return;
        }
        const frame = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data as ArrayBuffer);
        for (const listener of [...this.#frameListeners]) {
            listener(frame);
        }
    }

    #finish(error?: Error): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#closeError = error;
        for (const listener of [...this.#closeListeners]) {
            listener(error);
        }
        this.#closeListeners.clear();
    }
}
