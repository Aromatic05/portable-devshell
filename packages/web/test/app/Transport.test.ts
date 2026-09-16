import { describe, expect, it } from "vitest";

import {
    WebSocketChannel,
    type Channel,
    type WebSocketClientLike,
} from "@portable-devshell/shared/browser";
import {
    encodeFrame,
    FrameBuffer,
} from "@portable-devshell/shared/transport/frame";

import {
    connectBrowserWebSocketChannel,
    rpcUrl,
} from "../../src/app/transport/Socket.js";
import { webRoutePath } from "../../src/app/transport/Route.js";
import { createWebClients } from "../../src/app/transport/Client.js";

describe("WebSocketChannel", () => {
    it("writes raw binary data and notifies close once", async () => {
        const socket = new FakeSocket();
        const channel = new WebSocketChannel(
            socket as unknown as WebSocketClientLike,
        );
        let closeCount = 0;
        channel.onClose(() => (closeCount += 1));
        socket.open();

        await channel.write(
            new TextEncoder().encode('{"name":"service.status"}'),
        );

        expect(new TextDecoder().decode(socket.sent[0]!)).toBe(
            '{"name":"service.status"}',
        );
        socket.serverClose();
        socket.serverClose();
        expect(closeCount).toBe(1);
        await expect(channel.write(new Uint8Array())).rejects.toThrow("closed");
    });

    it("delivers ordered ArrayBuffer and Blob messages as raw data chunks", async () => {
        const socket = new FakeSocket();
        const channel = new WebSocketChannel(
            socket as unknown as WebSocketClientLike,
        );
        socket.open();
        const chunks: string[] = [];
        let resolveFrames!: () => void;
        const received = new Promise<void>((resolve) => {
            resolveFrames = resolve;
        });
        channel.onData((data) => {
            chunks.push(new TextDecoder().decode(data));
            if (chunks.length === 2) resolveFrames();
        });

        const first = new DeferredBlob("first");
        const second = new DeferredBlob("second");
        socket.message(first);
        socket.message(second);
        await first.started;
        second.release();
        first.release();
        await received;

        expect(chunks).toEqual(["first", "second"]);
    });

    it("closes when an open send throws", async () => {
        const socket = new FakeSocket();
        const channel = new WebSocketChannel(
            socket as unknown as WebSocketClientLike,
        );
        socket.open();
        socket.failOnSend();
        const errors: Error[] = [];
        channel.onClose((error) => {
            if (error !== undefined) errors.push(error);
        });

        await expect(channel.write(new Uint8Array([1]))).rejects.toThrow(
            "send failed",
        );

        expect(channel.closed).toBe(true);
        expect(errors).toHaveLength(1);
    });

    it("derives RPC routes from the deployed Web UI path", () => {
        const location = {
            host: "controller.example",
            pathname: "/devshell/web/",
            protocol: "https:",
        } as Location;

        expect(webRoutePath(location.pathname, "/rpc")).toBe(
            "/devshell/web/rpc",
        );
        expect(rpcUrl(location)).toBe(
            "wss://controller.example/devshell/web/rpc",
        );
        expect(webRoutePath("/unexpected", "/rpc")).toBe("/web/rpc");
    });

    it("does not create a socket for an already aborted connect", async () => {
        const controller = new AbortController();
        const reason = new Error("connect cancelled");
        controller.abort(reason);
        let factoryCalls = 0;

        await expect(
            connectBrowserWebSocketChannel(
                controller.signal,
                "ws://controller.test/web/rpc",
                () => {
                    factoryCalls += 1;
                    return new FakeSocket() as unknown as WebSocket;
                },
            ),
        ).rejects.toBe(reason);
        expect(factoryCalls).toBe(0);
    });

    it("closes a pending socket when connect is aborted", async () => {
        const socket = new FakeSocket();
        const controller = new AbortController();
        const reason = new Error("connect cancelled");
        const connecting = connectBrowserWebSocketChannel(
            controller.signal,
            "ws://controller.test/web/rpc",
            () => socket as unknown as WebSocket,
        );

        controller.abort(reason);

        await expect(connecting).rejects.toBe(reason);
        expect(socket.readyState).toBe(FakeSocket.CLOSED);
    });
});

class FakeSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    binaryType = "";
    readyState = FakeSocket.CONNECTING;
    sent: Uint8Array[] = [];
    #failSend = false;

    send(data: ArrayBufferView | ArrayBuffer): void {
        if (this.#failSend) throw new Error("send failed");
        const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
        this.sent.push(Uint8Array.from(bytes));
    }

    failOnSend(): void {
        this.#failSend = true;
    }

    close(): void {
        this.serverClose(1000);
    }

    open(): void {
        this.readyState = FakeSocket.OPEN;
        this.dispatchEvent(new Event("open"));
    }

    serverClose(code = 1006): void {
        this.readyState = FakeSocket.CLOSED;
        const event = new Event("close") as Event & {
            code?: number;
            reason?: string;
        };
        event.code = code;
        event.reason = "";
        this.dispatchEvent(event);
    }

    message(data: ArrayBuffer | Blob): void {
        this.dispatchEvent(new MessageEvent("message", { data }));
    }
}

class DeferredBlob extends Blob {
    readonly started: Promise<void>;
    readonly #ready: Promise<void>;
    #markStarted!: () => void;
    #release!: () => void;

    constructor(value: string) {
        super([value]);
        this.started = new Promise((resolve) => {
            this.#markStarted = resolve;
        });
        this.#ready = new Promise((resolve) => {
            this.#release = resolve;
        });
    }

    release(): void {
        this.#release();
    }

    override async arrayBuffer(): Promise<ArrayBuffer> {
        this.#markStarted();
        await this.#ready;
        return await super.arrayBuffer();
    }
}

describe("web client transport", () => {
    it("reports an unexpected persistent transport close", async () => {
        const channel = new ReplyChannel();
        const clients = createWebClients(async () => channel);
        const failures: string[] = [];
        clients.onTransportClose((error) => failures.push(error.message));
        await clients.service.hello();

        channel.close(new Error("transport lost"));

        expect(failures).toEqual(["transport lost"]);
    });
});

class ReplyChannel implements Channel {
    closed = false;
    private readonly dataListeners = new Set<(data: Uint8Array) => void>();
    private readonly frames = new FrameBuffer();
    private readonly closes = new Set<(error?: Error) => void>();

    async write(data: Uint8Array): Promise<void> {
        for (const frame of this.frames.push(data)) {
            const request = JSON.parse(new TextDecoder().decode(frame)) as {
                destination: string;
                id: string;
                name: string;
            };
            const reply = {
                destination: request.destination,
                from: "server",
                id: `reply-${request.id}`,
                name: request.name,
                payload: {
                    capabilities: ["request", "stream", "streamResume"],
                    protocolVersion: 1,
                },
                replyTo: request.id,
                to: "web",
            };
            queueMicrotask(() => {
                const encoded = encodeFrame(
                    new TextEncoder().encode(JSON.stringify(reply)),
                );
                for (const listener of this.dataListeners) listener(encoded);
            });
        }
    }

    onData(listener: (data: Uint8Array) => void): () => void {
        this.dataListeners.add(listener);
        return () => this.dataListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.closes.add(listener);
        return () => this.closes.delete(listener);
    }

    close(error?: Error): void {
        this.closed = true;
        for (const listener of this.closes) listener(error);
    }
}
