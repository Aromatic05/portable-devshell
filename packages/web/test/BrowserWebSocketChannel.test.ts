import { describe, expect, it } from "vitest";

import { BrowserWebSocketChannel } from "../src/rpc/BrowserWebSocketChannel.js";
import { rpcUrl } from "../src/rpc/BrowserWebSocketChannelProvider.js";
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
});

class FakeSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    binaryType = "";
    readyState = FakeSocket.CONNECTING;
    sent: Uint8Array[] = [];

    send(data: Uint8Array): void {
        this.sent.push(data);
    }

    close(): void {
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
