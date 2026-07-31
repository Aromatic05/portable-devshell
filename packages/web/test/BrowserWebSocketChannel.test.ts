import { describe, expect, it } from "vitest";

import { BrowserWebSocketChannel } from "../src/rpc/BrowserWebSocketChannel.js";
import {
    BrowserWebSocketChannelProvider,
    rpcUrl,
} from "../src/rpc/BrowserWebSocketChannelProvider.js";
import { webRoutePath } from "../src/routing/webRoute.js";

describe("BrowserWebSocketChannel", () => {
    it("queues initial raw JSON frames and notifies close once", async () => {
        const socket = new FakeSocket();
        const channel = new BrowserWebSocketChannel(
            socket as unknown as WebSocket,
        );
        let closeCount = 0;
        channel.onClose(() => (closeCount += 1));

        const sent = channel.send(
            new TextEncoder().encode('{"name":"service.status"}'),
        );
        socket.open();
        await sent;
        expect(new TextDecoder().decode(socket.sent[0]!)).toBe(
            '{"name":"service.status"}',
        );
        expect(socket.sent[0]![0]).toBe(123);

        socket.serverClose();
        socket.serverClose();
        expect(closeCount).toBe(1);
        await expect(channel.send(new Uint8Array())).rejects.toThrow("closed");
    });

    it("decodes one binary WebSocket message as one frame", async () => {
        const socket = new FakeSocket();
        const channel = new BrowserWebSocketChannel(
            socket as unknown as WebSocket,
        );
        socket.open();
        const frames: string[] = [];
        const off = channel.onFrame((frame) =>
            frames.push(new TextDecoder().decode(frame)),
        );

        socket.message(new TextEncoder().encode("one").buffer);
        socket.message(new Blob(["two"]));
        await new Promise((resolve) => setTimeout(resolve));
        off();
        socket.message(new TextEncoder().encode("three").buffer);

        expect(frames).toEqual(["one", "two"]);
    });

    it("preserves Blob message order and isolates listener failures", async () => {
        const socket = new FakeSocket();
        const channel = new BrowserWebSocketChannel(socket as unknown as WebSocket);
        socket.open();
        const frames: string[] = [];
        channel.onFrame(() => {
            throw new Error("broken frame listener");
        });
        channel.onFrame((frame) => frames.push(new TextDecoder().decode(frame)));
        const closes: string[] = [];
        channel.onClose(() => {
            throw new Error("broken close listener");
        });
        channel.onClose(() => closes.push("closed"));

        socket.message(new DelayedBlob("first", 20));
        socket.message(new DelayedBlob("second", 0));
        await new Promise((resolve) => setTimeout(resolve, 30));
        socket.serverClose();

        expect(frames).toEqual(["first", "second"]);
        expect(closes).toEqual(["closed"]);
    });

    it("closes and notifies listeners when an OPEN send throws", async () => {
        const socket = new FakeSocket();
        const channel = new BrowserWebSocketChannel(socket as unknown as WebSocket);
        socket.open();
        socket.failOnSend(1);
        socket.failOnClose();
        const errors: Error[] = [];
        channel.onClose((error) => {
            if (error !== undefined) errors.push(error);
        });

        await expect(channel.send(new Uint8Array([1]))).rejects.toThrow("send failed");

        expect(channel.closed).toBe(true);
        expect(errors).toHaveLength(1);
        await expect(channel.send(new Uint8Array([2]))).rejects.toThrow("closed");
    });

    it("rejects the remaining queue when a CONNECTING flush send throws", async () => {
        const socket = new FakeSocket();
        const channel = new BrowserWebSocketChannel(socket as unknown as WebSocket);
        const closes: Error[] = [];
        channel.onClose((error) => {
            if (error !== undefined) closes.push(error);
        });
        const first = channel.send(new Uint8Array([1]));
        const failed = channel.send(new Uint8Array([2]));
        const pending = channel.send(new Uint8Array([3]));
        socket.failOnSend(2);
        socket.failOnClose();

        socket.open();

        await expect(first).resolves.toBeUndefined();
        await expect(failed).rejects.toThrow("send failed");
        await expect(pending).rejects.toThrow("send failed");
        expect(channel.closed).toBe(true);
        expect(closes).toHaveLength(1);
    });

    it("derives RPC routes from the deployed WebUI path", () => {
        const location = {
            host: "controller.example",
            pathname: "/devshell/web/",
            protocol: "https:",
        } as Location;

        expect(webRoutePath(location.pathname, "/rpc")).toBe("/devshell/web/rpc");
        expect(rpcUrl(location)).toBe("wss://controller.example/devshell/web/rpc");
        expect(webRoutePath("/unexpected", "/rpc")).toBe("/web/rpc");
    });

    it("does not create a WebSocket for an already aborted connect", async () => {
        const controller = new AbortController();
        const reason = new Error("connect cancelled");
        controller.abort(reason);
        let factoryCalls = 0;
        const provider = new BrowserWebSocketChannelProvider(
            "ws://controller.test/web/rpc",
            () => {
                factoryCalls += 1;
                return new FakeSocket() as unknown as WebSocket;
            },
        );

        await expect(provider.connect(controller.signal)).rejects.toBe(reason);
        expect(factoryCalls).toBe(0);
    });

    it("closes a pending WebSocket when connect is aborted", async () => {
        const socket = new FakeSocket();
        const provider = new BrowserWebSocketChannelProvider(
            "ws://controller.test/web/rpc",
            () => socket as unknown as WebSocket,
        );
        const controller = new AbortController();
        const reason = new Error("connect cancelled");
        const connecting = provider.connect(controller.signal);

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
    #failSendAt?: number;
    #failClose = false;
    #sendCount = 0;

    send(data: Uint8Array): void {
        this.#sendCount += 1;
        if (this.#sendCount === this.#failSendAt) {
            throw new Error("send failed");
        }
        this.sent.push(data);
    }

    failOnSend(count: number): void {
        this.#failSendAt = count;
    }

    failOnClose(): void {
        this.#failClose = true;
    }

    close(): void {
        if (this.#failClose) {
            throw new Error("close failed");
        }
        this.serverClose();
    }

    open(): void {
        this.readyState = FakeSocket.OPEN;
        this.dispatchEvent(new Event("open"));
    }

    serverClose(): void {
        this.readyState = FakeSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
    }

    message(data: ArrayBuffer | Blob): void {
        this.dispatchEvent(new MessageEvent("message", { data }));
    }
}

class DelayedBlob extends Blob {
    constructor(
        private readonly value: string,
        private readonly delayMs: number,
    ) {
        super([value]);
    }

    override async arrayBuffer(): Promise<ArrayBuffer> {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        return await super.arrayBuffer();
    }
}
