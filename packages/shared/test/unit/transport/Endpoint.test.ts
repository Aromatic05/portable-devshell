import assert from "node:assert/strict";
import test from "node:test";

import {
    Endpoint,
    Event,
    Rpc,
    Stream,
    type Channel,
    type MessageStream,
} from "@portable-devshell/shared";
import { FRAME_MAX_DATA_SIZE } from "@portable-devshell/shared/transport/frame";

class MemoryChannel implements Channel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #dataListeners = new Set<(data: Uint8Array) => void>();
    #closed = false;
    #peer?: MemoryChannel;

    get closed(): boolean {
        return this.#closed;
    }

    connect(peer: MemoryChannel): void {
        this.#peer = peer;
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.#closed) throw new Error("Memory channel is closed.");
        const peer = this.#peer;
        if (peer === undefined || peer.#closed) throw new Error("Peer is closed.");
        const copy = Uint8Array.from(data);
        queueMicrotask(() => peer.#accept(copy));
    }

    onData(listener: (data: Uint8Array) => void): () => void {
        this.#dataListeners.add(listener);
        return () => this.#dataListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    close(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const listener of this.#closeListeners) listener(error);
        const peer = this.#peer;
        if (peer !== undefined) queueMicrotask(() => peer.#remoteClose(error));
    }

    #accept(data: Uint8Array): void {
        if (this.#closed) return;
        for (const listener of this.#dataListeners) listener(data);
    }

    #remoteClose(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const listener of this.#closeListeners) listener(error);
    }
}

async function endpoints(): Promise<{
    client: Endpoint;
    server: Endpoint;
}> {
    const left = new MemoryChannel();
    const right = new MemoryChannel();
    left.connect(right);
    right.connect(left);
    let connected = false;
    const client = new Endpoint({
        host: "control",
        connectChannel: async () => {
            assert.equal(connected, false);
            connected = true;
            return left;
        },
    });
    const server = new Endpoint({ host: "worker" });
    const accepting = server.accept(right);
    await client.connect("worker", "core");
    await accepting;
    return { client, server };
}

test("Endpoint routes Rpc across host:port and Envelope fragmentation", async (t) => {
    const { client, server } = await endpoints();
    t.after(() => {
        client.close();
        server.close();
    });
    const serverRpc = new Rpc(server.bind("core"), {
        echo: (message) => message,
    });
    const clientRpc = new Rpc(await client.connect("worker", "core"));
    t.after(() => {
        clientRpc.close();
        serverRpc.close();
    });

    const message = "x".repeat(FRAME_MAX_DATA_SIZE * 2);
    assert.equal(await clientRpc.request("echo", message), message);
});

test("Event binds directly to a Connection and Port", async (t) => {
    const { client, server } = await endpoints();
    t.after(() => {
        client.close();
        server.close();
    });
    const events = new Event(server.bind("tool"));
    const received = new Promise<unknown>((resolve) =>
        events.onEvent((name, message, peer) => {
            assert.equal(name, "progress");
            assert.deepEqual(peer, { host: "control", port: "tool" });
            resolve(message);
        }),
    );
    const sender = new Event(await client.connect("worker", "tool"));
    t.after(() => {
        events.close();
        sender.close();
    });
    await sender.send("progress", { value: 7 });
    assert.deepEqual(await received, { value: 7 });
});

test("Stream uses one Connection for byte messages", async (t) => {
    const { client, server } = await endpoints();
    t.after(() => {
        client.close();
        server.close();
    });
    const streams = new Stream(server.bind("process"));
    const echoed = new Promise<void>((resolve, reject) => {
        streams.onOpen((stream) => {
            void echo(stream).then(resolve, reject);
        });
    });
    const clientStreams = new Stream(await client.connect("worker", "process"));
    const stream = await clientStreams.open("exec", { command: "cat" });
    t.after(() => {
        clientStreams.close();
        streams.close();
    });
    await stream.write(Uint8Array.of(1, 2, 3));
    await stream.finish();
    assert.deepEqual(await stream.read(), Uint8Array.of(1, 2, 3));
    assert.equal(await stream.read(), undefined);
    await echoed;
});

async function echo(stream: MessageStream): Promise<void> {
    const data = await stream.read();
    assert.deepEqual(data, Uint8Array.of(1, 2, 3));
    await stream.write(data!);
    assert.equal(await stream.read(), undefined);
    await stream.finish();
}
