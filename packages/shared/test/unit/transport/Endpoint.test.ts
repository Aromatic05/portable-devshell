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
import { createTransportId } from "../../../src/transport/endpoint/Address.ts";

class MemoryChannel implements Channel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #dataListeners = new Set<(data: Uint8Array) => void>();
    #closed = false;
    #peer?: MemoryChannel;
    closeCalls = 0;

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
        this.closeCalls += 1;
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
    dispose: () => void;
    right: MemoryChannel;
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
    const dispose = await accepting;
    return { client, dispose, right, server };
}

test("accepted Endpoint link retires when its Channel closes", async () => {
    const { client, dispose, right, server } = await endpoints();
    client.disconnect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closeCalls = right.closeCalls;
    dispose();
    assert.equal(right.closeCalls, closeCalls);
    server.close();
});

test("Endpoint retries transient channel establishment without replaying RPC", async (t) => {
    const server = new Endpoint({ host: "worker" });
    const accepts: Array<Promise<() => void>> = [];
    let attempts = 0;
    let executions = 0;
    const client = new Endpoint({
        host: "client",
        connectChannel: async () => {
            attempts++;
            if (attempts < 3)
                throw Object.assign(new Error("temporary network reset"), { code: "ECONNRESET" });
            const left = new MemoryChannel();
            const right = new MemoryChannel();
            left.connect(right);
            right.connect(left);
            accepts.push(server.accept(right));
            return left;
        },
    });
    const handler = new Rpc(server.bind("core"), {
        ping: () => { executions++; return "pong"; },
    });
    t.after(async () => {
        client.close();
        server.close();
        handler.close();
        for (const detach of await Promise.all(accepts)) detach();
    });
    const rpc = new Rpc(await client.connect("worker", "core"));
    t.after(() => rpc.close());
    assert.equal(await rpc.request("ping"), "pong");
    assert.equal(attempts, 3);
    assert.equal(executions, 1, "a recovered connection must not replay any RPC");
});

test("Endpoint does not retry non-transient errors or an aborted connection", async () => {
    let attempts = 0;
    const unrecoverable = new Endpoint({
        connectChannel: async () => {
            attempts++;
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
    });
    await assert.rejects(unrecoverable.connect("worker", "core"), /permission denied/u);
    assert.equal(attempts, 1);
    unrecoverable.close();

    attempts = 0;
    const controller = new AbortController();
    const interrupted = new Endpoint({
        connectChannel: async () => {
            attempts++;
            controller.abort(new Error("user cancelled"));
            throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
        },
    });
    await assert.rejects(interrupted.connect("worker", "core", controller.signal),
        /connection reset/u);
    assert.equal(attempts, 1, "caller cancellation prevents every reconnect attempt");
    interrupted.close();
});

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

test("Endpoint wildcard host preserves the concrete RPC destination and exact routes win", async (t) => {
    const { client, server } = await endpoints();
    t.after(() => {
        client.close();
        server.close();
    });
    const wildcard = new Rpc(server.bind("tool", "*"), {
        call: (_message, context) => {
            assert.deepEqual(context.local, {
                host: "nonexistent",
                port: "tool",
            });
            return { route: "wildcard" };
        },
    });
    const exact = new Rpc(server.bind("tool", "known"), {
        call: (_message, context) => {
            assert.deepEqual(context.local, { host: "known", port: "tool" });
            return { route: "exact" };
        },
    });
    t.after(() => {
        wildcard.close();
        exact.close();
    });

    const missing = new Rpc(await client.connect("nonexistent", "tool"));
    const known = new Rpc(await client.connect("known", "tool"));
    t.after(() => {
        missing.close();
        known.close();
    });
    assert.deepEqual(await missing.request("call"), { route: "wildcard" });
    assert.deepEqual(await known.request("call"), { route: "exact" });
});

test("Endpoint wildcard host preserves the concrete Stream destination", async (t) => {
    const { client, server } = await endpoints();
    t.after(() => {
        client.close();
        server.close();
    });
    const serverStreams = new Stream(server.bind("tool", "*"));
    serverStreams.onOpen(async (stream, name, _message, _peer, local) => {
        assert.equal(name, "callStream");
        assert.deepEqual(local, { host: "nonexistent", port: "tool" });
        await stream.close({ route: local.host });
    });
    const clientStreams = new Stream(
        await client.connect("nonexistent", "tool"),
    );
    t.after(() => {
        clientStreams.close();
        serverStreams.close();
    });
    const stream = await clientStreams.open("callStream");
    assert.deepEqual(await stream.readMessage(), {
        message: { route: "nonexistent" },
        type: "close",
    });
});

test("Rpc rejects when the remote route is unavailable", async (t) => {
    const { client, server } = await endpoints();
    t.after(() => {
        client.close();
        server.close();
    });
    const rpc = new Rpc(await client.connect("worker", "missing"));
    const serverRpc = new Rpc(server.bind("core"), { echo: (value) => value });
    const healthyRpc = new Rpc(await client.connect("worker", "core"));
    t.after(() => { rpc.close(); serverRpc.close(); healthyRpc.close(); });

    await assert.rejects(
        rpc.request("read"),
        /No route for worker:missing/u,
    );
    assert.equal(client.connected, true, "Missing RPC route must not disconnect the shared link");
    assert.deepEqual(await healthyRpc.request("echo", { ok: true }), { ok: true });
});

test("Rpc cancellation owns the cancel write during transport close", async (t) => {
    const { client, server } = await endpoints();
    t.after(() => {
        client.close();
        server.close();
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const serverRpc = new Rpc(server.bind("core"), {
        wait: async (_message, context) => {
            entered();
            await new Promise<void>((resolve) =>
                context.signal.addEventListener("abort", () => resolve(), {
                    once: true,
                }),
            );
            return { cancelled: true };
        },
    });
    const clientRpc = new Rpc(await client.connect("worker", "core"));
    t.after(() => {
        clientRpc.close();
        serverRpc.close();
    });
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    const request = clientRpc.request("wait", undefined, controller.signal);
    await started;

    controller.abort(reason);
    client.disconnect();

    await assert.rejects(request, reason);
});

test("Stream read rejects when the remote route is unavailable", async (t) => {
    const { client, server } = await endpoints();
    t.after(() => {
        client.close();
        server.close();
    });
    const protocol = new Stream(await client.connect("worker", "missing"));
    t.after(() => protocol.close());
    const stream = await protocol.open("subscribe");

    await assert.rejects(
        stream.readMessage(),
        /No route for worker:missing/u,
    );
    assert.equal(client.connected, true, "Missing Stream route must not disconnect the shared link");
    const serverRpc = new Rpc(server.bind("core"), { ping: () => "pong" });
    const healthyRpc = new Rpc(await client.connect("worker", "core"));
    t.after(() => { serverRpc.close(); healthyRpc.close(); });
    assert.equal(await healthyRpc.request("ping"), "pong");
});

test("Endpoint authenticates every new physical link before releasing concurrent callers", async (t) => {
    const server = new Endpoint({ host: "worker" });
    const accepts: Array<Promise<() => void>> = [];
    let helloCount = 0;
    let releaseSecondHello: (() => void) | undefined;
    const serverAuth = new Rpc(server.bind("auth"), {
        async hello() {
            helloCount += 1;
            if (helloCount === 2)
                await new Promise<void>((resolve) => { releaseSecondHello = resolve; });
            return { ready: true };
        },
    });
    const serverData = new Rpc(server.bind("core"), { echo: (value) => value });
    const client = new Endpoint({
        host: "client",
        connectChannel: async () => {
            const left = new MemoryChannel();
            const right = new MemoryChannel();
            left.connect(right);
            right.connect(left);
            accepts.push(server.accept(right));
            return left;
        },
        initializeConnection: async (connect) => {
            const auth = new Rpc(connect("worker", "auth"));
            try { await auth.request("hello"); }
            finally { auth.close(); }
        },
    });
    t.after(async () => {
        client.close();
        server.close();
        serverAuth.close();
        serverData.close();
        await Promise.all(accepts);
    });
    const first = new Rpc(await client.connect("worker", "core"));
    assert.equal(await first.request("echo", 1), 1);
    assert.equal(helloCount, 1);
    first.close();
    client.disconnect();
    const pending = client.connect("worker", "core");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(helloCount, 2);
    let ready = false;
    void pending.then(() => { ready = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ready, false, "Ordinary connection must wait for the handshake");
    releaseSecondHello?.();
    const second = new Rpc(await pending);
    assert.equal(await second.request("echo", 2), 2);
    second.close();
    assert.equal(helloCount, 2);
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

test("Stream chunks large raw writes without base64 envelopes", async (t) => {
    const { client, server } = await endpoints();
    t.after(() => {
        client.close();
        server.close();
    });
    const streams = new Stream(server.bind("process"));
    const opened = new Promise<MessageStream>((resolve) =>
        streams.onOpen((stream) => resolve(stream)),
    );
    const clientStreams = new Stream(await client.connect("worker", "process"));
    const stream = await clientStreams.open("exec");
    const remote = await opened;
    t.after(() => {
        clientStreams.close();
        streams.close();
    });
    const bytes = new Uint8Array(64 * 1024 * 3 + 7);
    bytes[0] = 1;
    bytes[bytes.byteLength - 1] = 2;
    await stream.write(bytes);

    const chunks = [
        await remote.read(),
        await remote.read(),
        await remote.read(),
        await remote.read(),
    ];
    assert.deepEqual(
        chunks.map((chunk) => chunk?.byteLength),
        [64 * 1024, 64 * 1024, 64 * 1024, 7],
    );
    assert.equal(chunks[0]?.[0], 1);
    assert.equal(chunks[3]?.[6], 2);
});

test("Stream close completes locally after transport disconnect", async (t) => {
    const { client, server } = await endpoints();
    t.after(() => {
        client.close();
        server.close();
    });
    const streams = new Stream(server.bind("runtime"));
    const clientStreams = new Stream(await client.connect("worker", "runtime"));
    const opened = new Promise<void>((resolve) =>
        streams.onOpen(() => resolve()),
    );
    const stream = await clientStreams.open("subscribe");
    await opened;

    const closing = stream.close();
    client.disconnect();
    await closing;

    clientStreams.close();
    streams.close();
});

test("Rpc handler does not reply after its peer disconnects", async () => {
    const endpoint = new Endpoint({ host: "router" });
    const serverPort = endpoint.bind("overview", "server");
    const clientPort = endpoint.bind("overview", "client");
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    const serverRpc = new Rpc(serverPort, {
        read: async () => {
            entered();
            await blocked;
            return { ok: true };
        },
    });
    const clientRpc = new Rpc(clientPort.connect("server", "overview"));
    const request = clientRpc.request("read").catch(() => undefined);
    await started;

    clientPort.close();
    clientRpc.close();
    release();
    await request;
    await new Promise<void>((resolve) => setImmediate(resolve));

    serverRpc.close();
    endpoint.close();
});


test("createTransportId falls back to getRandomValues when randomUUID is unavailable", () => {
    const arrays: ArrayBufferView[] = [];
    const source = {
        getRandomValues<T extends ArrayBufferView>(array: T): T {
            arrays.push(array);
            const bytes = array as unknown as Uint8Array;
            for (let index = 0; index < bytes.length; index += 1)
                bytes[index] = index;
            return array;
        },
    };

    const id = createTransportId(source);

    assert.equal(arrays.length, 1);
    assert.ok(arrays[0] instanceof Uint8Array);
    assert.equal((arrays[0] as Uint8Array).length, 16);
    assert.equal(id, "00010203-0405-4607-8809-0a0b0c0d0e0f");
    assert.equal(id[14], "4");
    assert.match(id[19]!, /[89ab]/u);
});

test("createTransportId prefers randomUUID when it is available", () => {
    let fallbacks = 0;
    const id = createTransportId({
        randomUUID: () => "random-uuid",
        getRandomValues<T extends ArrayBufferView>(array: T): T {
            fallbacks += 1;
            return array;
        },
    });

    assert.equal(id, "random-uuid");
    assert.equal(fallbacks, 0);
});

test("createTransportId fails closed without a secure random source", () => {
    const error = /cryptographically secure random source/u;
    assert.throws(() => createTransportId(null), error);
    assert.throws(() => createTransportId({}), error);
});

async function echo(stream: MessageStream): Promise<void> {
    const data = await stream.read();
    assert.deepEqual(data, Uint8Array.of(1, 2, 3));
    await stream.write(data!);
    assert.equal(await stream.read(), undefined);
    await stream.finish();
}
