import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test, { type TestContext } from "node:test";

import { Endpoint } from "../../../src/transport/endpoint/Endpoint.ts";
import { createPortClient } from "../../../src/transport/endpoint/PortClient.ts";
import { ChannelBase } from "../../../src/transport/endpoint/channel/Channel.ts";
import { Rpc } from "../../../src/transport/packet/Rpc.ts";
import { Stream, type MessageStream } from "../../../src/transport/packet/Stream.ts";
import { FrameProtocol } from "../../../src/transport/frame/Protocol.ts";
import { FrameStreamChannel } from "../../../src/transport/frame/Stream.ts";
import { EnvelopeCodec } from "../../../src/transport/envelope/Codec.ts";
import { Route } from "../../../src/transport/endpoint/route/Route.ts";
import { createWorkerArtifact } from "../../../../core/src/instance/runtime/execution/capability/artifact/Artifact.ts";
import { createToolTransport } from "../../../src/execution/toolcall/Transport.ts";

const turn = async () => await new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

// Exercise real Frame/Envelope routing without opening an OS socket.
class MemoryChannel extends ChannelBase {
    peer!: MemoryChannel;
    async write(data: Uint8Array): Promise<void> {
        assert.equal(this.closed, false);
        const copy = Uint8Array.from(data);
        queueMicrotask(() => this.peer.emitData(copy));
    }
    close(error?: Error): void {
        if (this.closed) return;
        this.finish(error);
        this.peer.finish(error);
    }
}
function pair() {
    const left = new MemoryChannel(), right = new MemoryChannel();
    left.peer = right; right.peer = left;
    return { left, right };
}
async function endpoints(t: TestContext) {
    const { left, right } = pair();
    const server = new Endpoint({ host: "server" });
    const client = new Endpoint({ host: "client", connectChannel: async () => left });
    const accepting = server.accept(right);
    t.after(() => { client.close(); server.close(); left.close(); });
    await client.connect("server", "test");
    await accepting;
    return { client, server, left };
}

for (const who of ["initiator", "joiner"] as const) {
    test(`Endpoint ${who} cancellation ends only its own wait`, { timeout: 3000 }, async (t) => {
        const { left, right } = pair();
        const release = deferred<void>();
        let attempts = 0;
        let connectionSignal: AbortSignal | undefined;
        const client = new Endpoint({ host: "client", connectChannel: async (signal) => {
            attempts++; connectionSignal = signal;
            await release.promise;
            return left;
        } });
        const server = new Endpoint({ host: "server" });
        const accepting = server.accept(right);
        t.after(() => { client.close(); server.close(); });
        const a = new AbortController(), b = new AbortController();
        const first = client.connect("server", "test", a.signal);
        const second = client.connect("server", "test", b.signal);
        const cancelled = who === "initiator" ? first : second;
        const surviving = who === "initiator" ? second : first;
        const rejection = assert.rejects(cancelled, /only this caller/);
        (who === "initiator" ? a : b).abort(new Error("only this caller"));
        await rejection;
        assert.equal(connectionSignal?.aborted, false);
        release.resolve();
        assert.equal((await surviving).connected, true);
        assert.equal(attempts, 1);
        await accepting;
    });
}

test("callers joining during initialization still wait independently for authentication", { timeout: 3000 }, async (t) => {
    const { left, right } = pair();
    const entered = deferred<void>(), release = deferred<void>();
    let effects = 0;
    const client = new Endpoint({ host: "client", connectChannel: async () => left,
        initializeConnection: async () => { entered.resolve(); await release.promise; },
    });
    const server = new Endpoint({ host: "server" });
    const rpc = new Rpc(server.bind("test"), { effect: () => ++effects });
    const accepting = server.accept(right);
    t.after(() => { release.resolve(); client.close(); server.close(); rpc.close(); });
    const port = createPortClient(client, "server", "test");
    const first = port.request("effect");
    await entered.promise;
    const controller = new AbortController();
    const cancelled = assert.rejects(port.request("effect", {}, controller.signal), /only joiner/);
    const second = port.request("effect");
    await turn();
    assert.equal(effects, 0, "a bound gateway cannot bypass pending initialization");
    controller.abort(new Error("only joiner"));
    await cancelled;
    release.resolve();
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    await accepting;
});

test("Endpoint close rejects old work, closes a late Channel, and allows a new generation", { timeout: 3000 }, async (t) => {
    const old = pair(), fresh = pair();
    const release = deferred<void>();
    let attempts = 0, effects = 0;
    const client = new Endpoint({ host: "client", connectChannel: async () => {
        if (++attempts === 1) { await release.promise; return old.left; }
        return fresh.left;
    } });
    const server = new Endpoint({ host: "server" });
    const rpc = new Rpc(server.bind("test"), { effect: () => ++effects });
    t.after(() => { client.close(); server.close(); rpc.close(); });
    const port = createPortClient(client, "server", "test");
    const request = assert.rejects(port.request("effect"), /Endpoint closed/);
    client.close();
    await request;
    const accepting = server.accept(fresh.right);
    assert.equal(await port.request("effect"), 1);
    await accepting;
    release.resolve();
    await turn();
    assert.equal(old.left.closed, true);
    assert.equal(effects, 1);
    assert.equal(client.connected, true);
});

test("PortClient cancels in the connect return window before sending OPEN", { timeout: 3000 }, async (t) => {
    const { client, server } = await endpoints(t);
    let opens = 0;
    const remote = new Stream(server.bind("test"));
    remote.onOpen(() => { opens++; });
    t.after(() => remote.close());
    const controller = new AbortController();
    const connection = await client.connect("server", "test");
    const port = createPortClient({ connect: async () => {
        controller.abort(new Error("connect handoff")); return connection;
    } } as unknown as Endpoint, "server", "test");
    await assert.rejects(port.open("subscribe", {}, controller.signal), /connect handoff/);
    await turn();
    assert.equal(opens, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("PortClient abort during async OPEN settles before send completes and cleans subscriptions", { timeout: 3000 }, async () => {
    const endpoint = new Endpoint({ host: "client" });
    const source = endpoint.bind("source"), target = endpoint.bind("test", "server");
    const release = deferred<void>(), entered = deferred<void>();
    let cancels = 0;
    target.onPacket(async (packet) => {
        if ((packet as { type: string }).type === "open") { entered.resolve(); await release.promise; }
        if ((packet as { type: string }).type === "cancel") cancels++;
    });
    let subscriptions = 0;
    const onPacket = source.onPacket.bind(source);
    source.onPacket = (listener) => {
        subscriptions++;
        const off = onPacket(listener);
        return () => { subscriptions--; off(); };
    };
    const port = createPortClient({ connect: async () => source.connect("server", "test") } as unknown as Endpoint, "server", "test");
    const controller = new AbortController();
    try {
        const opening = assert.rejects(port.open("subscribe", {}, controller.signal), /during OPEN/);
        await entered.promise;
        controller.abort(new Error("during OPEN"));
        await opening;
        assert.equal(subscriptions, 0);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        release.resolve();
        await turn();
        assert.equal(cancels, 1);
    } finally { release.resolve(); endpoint.close(); }
});

test("each stream terminal path releases its shared signal listener", { timeout: 3000 }, async (t) => {
    const { client, server } = await endpoints(t);
    const remote = new Stream(server.bind("test"));
    t.after(() => remote.close());
    const port = createPortClient(client, "server", "test");
    const controller = new AbortController();
    for (const end of ["remote close", "local close", "remote cancel", "local cancel"] as const) {
        const opened = deferred<MessageStream>();
        const off = remote.onOpen((stream) => { opened.resolve(stream); });
        const stream = await port.open("subscribe", {}, controller.signal);
        const peer = await opened.promise;
        off();
        assert.equal(getEventListeners(controller.signal, "abort").length, 1);
        if (end === "remote close") await peer.close();
        if (end === "local close") await stream.close();
        if (end === "remote cancel") await peer.cancel();
        if (end === "local cancel") await stream.cancel();
        await turn();
        assert.equal(getEventListeners(controller.signal, "abort").length, 0, end);
    }
});

test("pre-aborted Tool calls execute no OPEN and oversized OPEN rolls back all packet subscriptions", { timeout: 5000 }, async (t) => {
    const { client, server } = await endpoints(t);
    const remote = new Stream(server.bind("tool"));
    let opens = 0;
    remote.onOpen(async (stream) => { opens++; await stream.close("ok"); });
    t.after(() => remote.close());
    const binding = client.bind("tool");
    let subscriptions = 0;
    const onPacket = binding.onPacket.bind(binding);
    binding.onPacket = (listener) => {
        subscriptions++;
        const off = onPacket(listener);
        return () => { subscriptions--; off(); };
    };
    const tool = createToolTransport(client, "server");
    await assert.rejects(tool.callStreaming("edit", {}, "/workspace", { signal: AbortSignal.abort(new Error("before call")) }), /before call/);
    assert.equal(opens, 0);
    for (let i = 0; i < 2; i++) {
        await assert.rejects(tool.callStreaming("edit", "x".repeat(17 * 1024 * 1024), "/workspace"));
        assert.equal(subscriptions, 0);
        assert.equal(opens, 0);
    }
    assert.equal(await tool.callStreaming("edit", {}, "/workspace"), "ok");
    await turn();
    assert.equal(subscriptions, 0);
    assert.equal(client.connected, true);
});

// A real Frame WINDOW is exhausted mid-envelope. Resume reading after local
// cancellation to prove the wire remains valid and a sibling RPC still works.
async function windowFixture(t: TestContext) {
    const { left, right } = pair();
    const client = new Endpoint({ host: "client", connectChannel: async () => left });
    const frame = new FrameProtocol(right, { role: "acceptor", receiveWindow: 1024 });
    const opening = client.connect("server", "test");
    const request = await frame.nextOpen();
    assert.ok(request);
    const stream = await request.accept();
    await opening;
    const route = new Route();
    t.after(() => { client.close(); frame.close(); });
    return { client, left, stream, resume: () => {
        const codec = new EnvelopeCodec(new FrameStreamChannel(stream));
        route.attach(codec, right);
    }, route };
}

test("RPC abort settles at zero WINDOW without closing or truncating the shared Channel", { timeout: 3000 }, async (t) => {
    const fixture = await windowFixture(t);
    const entered = deferred<AbortSignal>();
    const rpc = new Rpc(fixture.route.bind("server", "test"), {
        wait: (_value, context) => { entered.resolve(context.signal); return new Promise(() => undefined); },
        echo: (value) => value,
    });
    t.after(() => rpc.close());
    const port = createPortClient(fixture.client, "server", "test");
    const controller = new AbortController();
    const waiting = assert.rejects(port.request("wait", "x".repeat(4096), controller.signal), /zero WINDOW/);
    await turn();
    controller.abort(new Error("zero WINDOW"));
    await waiting;
    assert.equal(fixture.left.closed, false);
    assert.equal(fixture.client.connected, true);
    fixture.resume();
    const signal = await entered.promise;
    assert.equal(await port.request("echo", "healthy"), "healthy");
    assert.equal(signal.aborted, true);
});

for (const cancellation of ["signal", "stream.cancel"] as const) {
test(`stream in-flight write rejects at zero WINDOW via ${cancellation} and preserves sibling RPC`, { timeout: 3000 }, async (t) => {
    const fixture = await windowFixture(t);
    const binding = fixture.route.bind("server", "test");
    const protocol = new Stream(binding);
    const peer = deferred<MessageStream>();
    protocol.onOpen((stream) => { peer.resolve(stream); });
    const rpc = new Rpc(binding, { echo: (value) => value });
    t.after(() => { protocol.close(); rpc.close(); });
    const port = createPortClient(fixture.client, "server", "test");
    const controller = new AbortController();
    const stream = await port.open("receive.write", {}, controller.signal);
    const writing = assert.rejects(stream.write(new Uint8Array(128 * 1024)), /zero WINDOW/);
    await turn();
    if (cancellation === "signal") controller.abort(new Error("zero WINDOW"));
    else await stream.cancel({ message: "zero WINDOW" });
    await writing;
    assert.equal(fixture.left.closed, false);
    assert.equal(fixture.client.connected, true);
    fixture.resume();
    const remote = await peer.promise;
    const cancelled = assert.rejects((async () => {
        while (true) await remote.readMessage();
    })(), /zero WINDOW/);
    assert.equal(await port.request("echo", "healthy"), "healthy");
    // The first in-flight DATA may be delivered before CANCEL; drain it first.
    await cancelled;
});

}

test("WorkerArtifact write cancellation returns at zero WINDOW and releases the transfer signal", { timeout: 3000 }, async (t) => {
    const fixture = await windowFixture(t);
    const binding = fixture.route.bind("server", "artifact");
    const receiver = new Stream(binding);
    const rpc = new Rpc(binding, { echo: (value) => value });
    t.after(() => { receiver.close(); rpc.close(); });
    const controller = new AbortController();
    const artifact = createWorkerArtifact(fixture.client, "server");
    const writing = assert.rejects(artifact.writeArtifactReceive({
        receiveId: "receive", offsetBytes: 0, bytes: new Uint8Array(128 * 1024),
    }, controller.signal), /cancel transfer/);
    await turn();
    controller.abort(new Error("cancel transfer"));
    await writing;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(fixture.client.connected, true);
    fixture.resume();
    const port = createPortClient(fixture.client, "server", "artifact");
    assert.equal(await port.request("echo", "healthy"), "healthy");
});
