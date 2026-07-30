import type { FrameChannel } from "@portable-devshell/shared/browser";

export class BrowserWebSocketChannel implements FrameChannel {
    #closed = false;
    #frames = new Set<(frame: Uint8Array) => void>();
    #closes = new Set<(error?: Error) => void>();
    #queue: Array<{
        frame: Uint8Array;
        reject: (error: Error) => void;
        resolve: () => void;
    }> = [];

    constructor(readonly socket: WebSocket) {
        socket.binaryType = "arraybuffer";
        socket.addEventListener("open", this.flush);
        socket.addEventListener("message", this.message);
        socket.addEventListener("close", this.closedEvent);
        socket.addEventListener("error", this.errorEvent);
    }

    get closed(): boolean {
        return this.#closed;
    }

    send(frame: Uint8Array): Promise<void> {
        if (
            this.#closed ||
            this.socket.readyState === WebSocket.CLOSING ||
            this.socket.readyState === WebSocket.CLOSED
        ) {
            return Promise.reject(new Error("WebSocket channel is closed."));
        }
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(frame);
            return Promise.resolve();
        }
        if (this.socket.readyState !== WebSocket.CONNECTING)
            return Promise.reject(new Error("WebSocket connection failed."));
        return new Promise((resolve, reject) =>
            this.#queue.push({ frame, reject, resolve }),
        );
    }

    onFrame(listener: (frame: Uint8Array) => void): () => void {
        this.#frames.add(listener);
        return () => this.#frames.delete(listener);
    }
    onClose(listener: (error?: Error) => void): () => void {
        this.#closes.add(listener);
        return () => this.#closes.delete(listener);
    }
    close(error?: Error): void {
        if (!this.#closed) {
            this.finish(error);
            this.socket.close();
        }
    }

    private flush = () => {
        for (const pending of this.#queue.splice(0)) {
            try {
                this.socket.send(pending.frame);
                pending.resolve();
            } catch (error) {
                pending.reject(asError(error));
            }
        }
    };
    private message = (event: MessageEvent<ArrayBuffer | Blob>) => {
        if (isArrayBuffer(event.data)) this.emit(new Uint8Array(event.data));
        else if (event.data instanceof Blob)
            void event.data
                .arrayBuffer()
                .then((data) => this.emit(new Uint8Array(data)))
                .catch((error) => this.finish(asError(error)));
    };
    private closedEvent = () =>
        this.finish(new Error("WebSocket connection closed."));
    private errorEvent = () =>
        this.finish(new Error("WebSocket connection failed."));
    private emit(frame: Uint8Array): void {
        if (!this.#closed) for (const listener of this.#frames) listener(frame);
    }
    private finish(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        this.socket.removeEventListener("open", this.flush);
        this.socket.removeEventListener("message", this.message);
        this.socket.removeEventListener("close", this.closedEvent);
        this.socket.removeEventListener("error", this.errorEvent);
        for (const pending of this.#queue.splice(0))
            pending.reject(error ?? new Error("WebSocket channel is closed."));
        for (const listener of this.#closes) listener(error);
        this.#frames.clear();
        this.#closes.clear();
    }
}
function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
function isArrayBuffer(value: unknown): value is ArrayBuffer {
    return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}
