import { describe, expect, it } from "vitest";

import { BrowserWebSocketChannel } from "../src/rpc/BrowserWebSocketChannel.js";

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
