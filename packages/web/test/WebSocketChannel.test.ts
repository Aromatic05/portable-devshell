import { describe, expect, it } from "vitest";

import {
    WebSocketChannel,
    type WebSocketClientLike,
} from "@portable-devshell/shared/browser";

import {
    connectBrowserWebSocketChannel,
    rpcUrl,
} from "../src/rpc/WebSocketConnector.js";
import { webRoutePath } from "../src/routing/webRoute.js";

describe("WebSocketChannel", () => {
    it("sends one binary message per frame and notifies close once", async () => {
        const socket = new FakeSocket();
        const channel = new WebSocketChannel(socket as unknown as WebSocketClientLike);
        let closeCount = 0;
        channel.onClose(() => (closeCount += 1));
        socket.open();

        await channel.send(
            new TextEncoder().encode('{"name":"service.status"}'),
        );

        expect(new TextDecoder().decode(socket.sent[0]!)).toBe(
            '{"name":"service.status"}',
        );
        socket.serverClose();
        socket.serverClose();
        expect(closeCount).toBe(1);
        await expect(channel.send(new Uint8Array())).rejects.toThrow("closed");
    });

    it("decodes ordered ArrayBuffer and Blob messages as frames", async () => {
        const socket = new FakeSocket();
        const channel = new WebSocketChannel(socket as unknown as WebSocketClientLike);
        socket.open();
        const frames: string[] = [];
        let resolveFrames!: () => void;
        const received = new Promise<void>((resolve) => {
            resolveFrames = resolve;
        });
        channel.onFrame((frame) => {
            frames.push(new TextDecoder().decode(frame));
            if (frames.length === 2) resolveFrames();
        });

        const first = new DeferredBlob("first");
        const second = new DeferredBlob("second");
        socket.message(first);
        socket.message(second);
        await first.started;
        second.release();
        first.release();
        await received;

        expect(frames).toEqual(["first", "second"]);
    });

    it("closes when an open send throws", async () => {
        const socket = new FakeSocket();
        const channel = new WebSocketChannel(socket as unknown as WebSocketClientLike);
        socket.open();
        socket.failOnSend();
        const errors: Error[] = [];
        channel.onClose((error) => {
            if (error !== undefined) errors.push(error);
        });

        await expect(channel.send(new Uint8Array([1]))).rejects.toThrow(
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
