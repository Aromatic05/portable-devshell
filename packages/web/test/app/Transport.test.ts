import { describe, expect, it } from "vitest";

import {
    CONTROL_PROTOCOL_VERSION,
    Endpoint,
    Rpc,
    WebChannel,
    type Channel,
    type WebSocketClientLike,
} from "@portable-devshell/shared";

import {
    connectBrowserWebChannel,
    rpcUrl,
} from "../../src/app/transport/Socket.js";
import { webRoutePath } from "../../src/app/transport/Route.js";
import { createWebDomainSession } from "../../src/app/transport/Client.js";

describe("WebChannel", () => {
    it("writes raw binary data and notifies close once", async () => {
        const socket = new FakeSocket();
        const channel = new WebChannel(
            socket as unknown as WebSocketClientLike,
        );
        let closeCount = 0;
        channel.onClose(() => (closeCount += 1));
        socket.open();

        await channel.write(
            new TextEncoder().encode('{"name":"server.status"}'),
        );

        expect(new TextDecoder().decode(socket.sent[0]!)).toBe(
            '{"name":"server.status"}',
        );
        socket.serverClose();
        socket.serverClose();
        expect(closeCount).toBe(1);
        await expect(channel.write(new Uint8Array())).rejects.toThrow("closed");
    });

    it("delivers ordered ArrayBuffer and Blob messages as raw data chunks", async () => {
        const socket = new FakeSocket();
        const channel = new WebChannel(
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
        const channel = new WebChannel(
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
            connectBrowserWebChannel(
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
        const connecting = connectBrowserWebChannel(
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

describe("web domain transport", () => {
    it("reports an unexpected persistent transport close", async () => {
        const clientChannel = new MemoryChannel();
        const serverChannel = new MemoryChannel();
        clientChannel.connect(serverChannel);
        serverChannel.connect(clientChannel);
        const server = new Endpoint({ host: "control" });
        const accepting = server.accept(serverChannel);
        const service = new Rpc(server.bind("service", "@control"), {
            hello: () => ({
                capabilities: ["request", "stream", "streamResume"],
                protocolVersion: CONTROL_PROTOCOL_VERSION,
            }),
            status: () => ({ instanceCount: 0, ok: true }),
        });
        const domains = createWebDomainSession(async () => clientChannel);
        const closed = new Promise<string>((resolve) => {
            const unsubscribe = domains.server.subscribe(() => {
                const state = domains.server.state;
                if (state.status !== "offline") return;
                unsubscribe();
                resolve(state.failure?.message ?? "closed");
            });
        });
        await domains.server.connect();
        await accepting;

        serverChannel.close(new Error("transport lost"));

        expect(await closed).toBe("transport lost");
        serverRpc.close();
        server.close();
        domains.close();
    });
});

class MemoryChannel implements Channel {
    closed = false;
    readonly #data = new Set<(data: Uint8Array) => void>();
    readonly #close = new Set<(error?: Error) => void>();
    #peer?: MemoryChannel;

    connect(peer: MemoryChannel): void {
        this.#peer = peer;
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.closed) throw new Error("channel closed");
        const peer = this.#peer;
        if (peer === undefined || peer.closed) throw new Error("peer closed");
        const copy = Uint8Array.from(data);
        queueMicrotask(() => {
            for (const listener of peer.#data) listener(copy);
        });
    }

    onData(listener: (data: Uint8Array) => void): () => void {
        this.#data.add(listener);
        return () => this.#data.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.#close.add(listener);
        return () => this.#close.delete(listener);
    }

    close(error?: Error): void {
        if (this.closed) return;
        this.closed = true;
        for (const listener of this.#close) listener(error);
        const peer = this.#peer;
        if (peer !== undefined && !peer.closed) {
            peer.closed = true;
            queueMicrotask(() => {
                for (const listener of peer.#close) listener(error);
            });
        }
    }
}
