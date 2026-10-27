import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import {
    Endpoint,
    Stream,
    StreamChannel,
    type Channel,
    type MessageStream,
} from "@portable-devshell/shared";

const drain = async () => await new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(t: TestContext) {
    const server = new Endpoint({ host: "server" });
    const protocol = new Stream(server.bind("probe"));
    const opened: MessageStream[] = [];
    const incoming: Array<Channel | undefined> = [];
    protocol.onOpen((stream, _name, _message, _peer, _local, channel) => {
        opened.push(stream);
        incoming.push(channel);
    });
    t.after(() => { protocol.close(); server.close(); });
    const client = async () => {
        const up = new PassThrough();
        const down = new PassThrough();
        let closed = false;
        const closeTransport = (error?: Error) => {
            if (closed) return;
            closed = true;
            up.destroy();
            down.destroy();
            local.close(error);
            remote.close(error);
        };
        const local = new StreamChannel(down, up, { closeTransport });
        const remote = new StreamChannel(up, down, { closeTransport });
        const endpoint = new Endpoint({ host: "shared-host", connectChannel: async () => local });
        t.after(() => endpoint.close());
        const accepting = server.accept(remote);
        const connection = await endpoint.connect("server", "probe");
        await accepting;
        const packets: unknown[] = [];
        connection.onPacket((packet) => { packets.push(packet); });
        return { endpoint, connection, packets, remote };
    };
    return { client, opened, incoming };
}

test("retained Stream data, FIN and terminal stay on their incoming Channel after Host reuse", { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    const a = await f.client();
    const caller = new Stream(a.connection);
    t.after(() => caller.close());
    const stream = await caller.open("retained");
    await drain();
    const retained = f.opened[0]!;
    const b = await f.client();
    await b.connection.send({ protocol: "event", name: "switch-peer" });
    await drain();

    await retained.write(Uint8Array.of(1, 2, 3));
    await retained.send({ private: "A" });
    await retained.finish();
    await drain();
    assert.deepEqual(b.packets, []);
    assert.deepEqual(a.packets, [
        { protocol: "stream", type: "data", id: stream.id, seq: 1, bytes: Uint8Array.of(1, 2, 3) },
        { protocol: "stream", type: "data", id: stream.id, seq: 2, message: { private: "A" } },
        { protocol: "stream", type: "fin", id: stream.id },
    ]);
    assert.deepEqual(await stream.read(), Uint8Array.of(1, 2, 3));
    assert.deepEqual(await stream.readMessage(), { type: "data", seq: 2, message: { private: "A" } });
    assert.deepEqual(await stream.readMessage(), { type: "fin" });

    await retained.close({ done: "A" });
    await drain();
    assert.deepEqual(b.packets, []);
    assert.deepEqual(await stream.readMessage(), { type: "close", message: { done: "A" } });
});

for (const terminal of ["close", "cancel"] as const) {
    test(`same Host and stream id isolate input, FIN and ${terminal} by Channel`, { timeout: 5000 }, async (t) => {
        const f = await fixture(t);
        const a = await f.client();
        await a.connection.send({ protocol: "stream", type: "open", id: "collision", name: "A" });
        await drain();
        const b = await f.client();
        await b.connection.send({ protocol: "stream", type: "open", id: "collision", name: "B" });
        await drain();
        assert.equal(f.opened.length, 2);
        assert.notEqual(f.incoming[0], f.incoming[1]);
        const [original, alternate] = f.opened as [MessageStream, MessageStream];
        const dataA: unknown[] = [];
        const dataB: unknown[] = [];
        const closedA: unknown[] = [];
        const closedB: unknown[] = [];
        const cancelledA: unknown[] = [];
        const cancelledB: unknown[] = [];
        original.onData((message, seq) => { dataA.push({ message, seq }); });
        alternate.onData((message, seq) => { dataB.push({ message, seq }); });
        original.onClose((message) => { closedA.push(message); });
        alternate.onClose((message) => { closedB.push(message); });
        original.onCancel((error) => { cancelledA.push(error); });
        alternate.onCancel((error) => { cancelledB.push(error); });
        await a.connection.send({ protocol: "stream", type: "data", id: "collision", seq: 1, message: "A" });
        await drain();
        assert.deepEqual(dataA, [{ message: "A", seq: 1 }]);
        assert.deepEqual(dataB, []);
        await b.connection.send({ protocol: "stream", type: "data", id: "collision", seq: 1, message: "B" });
        await a.connection.send({ protocol: "stream", type: "fin", id: "collision" });
        await drain();
        assert.deepEqual(await original.readMessage(), { type: "fin" });
        await a.connection.send({ protocol: "stream", type: terminal, id: "collision" });
        await drain();
        assert.deepEqual(closedA, terminal === "close" ? [undefined] : []);
        assert.deepEqual(cancelledA, terminal === "cancel" ? [undefined] : []);
        assert.deepEqual(closedB, []);
        assert.deepEqual(cancelledB, []);
        await b.connection.send({ protocol: "stream", type: "data", id: "collision", seq: 2, message: "B-still-active" });
        await drain();
        assert.deepEqual(dataB, [{ message: "B", seq: 1 }, { message: "B-still-active", seq: 2 }]);
        await alternate.close({ done: "B" });
        await drain();
        assert.deepEqual(a.packets, []);
        assert.deepEqual(b.packets, [{ protocol: "stream", type: "close", id: "collision", message: { done: "B" } }]);
    });
}

test("retained error cancellation uses A and its cleanup preserves B with the same id", { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    const a = await f.client();
    await a.connection.send({ protocol: "stream", type: "open", id: "collision", name: "A" });
    await drain();
    const b = await f.client();
    await b.connection.send({ protocol: "stream", type: "open", id: "collision", name: "B" });
    await drain();
    const error = { message: "A failed", code: "fixture.failure", retryable: false };
    await f.opened[0]!.cancel(error);
    await drain();
    assert.deepEqual(a.packets, [{ protocol: "stream", type: "cancel", id: "collision", error }]);
    assert.deepEqual(b.packets, []);
    await b.connection.send({ protocol: "stream", type: "data", id: "collision", seq: 1, message: "B" });
    await drain();
    assert.deepEqual(await f.opened[1]!.readMessage(), { type: "data", seq: 1, message: "B" });
    await f.opened[1]!.close();
    await drain();
    assert.deepEqual(b.packets, [{ protocol: "stream", type: "close", id: "collision" }]);
});

test("closing A's Channel cancels only A's retained stream while B keeps its session", { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    const a = await f.client();
    await a.connection.send({ protocol: "stream", type: "open", id: "collision", name: "A" });
    await drain();
    const b = await f.client();
    await b.connection.send({ protocol: "stream", type: "open", id: "collision", name: "B" });
    await drain();
    const cancellations: unknown[] = [];
    f.opened[0]!.onCancel((error) => { cancellations.push(error); });
    const rejected = assert.rejects(f.opened[0]!.readMessage(), /session A closed/u);
    a.remote.close(new Error("session A closed"));
    await drain();
    assert.deepEqual(cancellations, [{ message: "session A closed" }]);
    await rejected;
    await f.opened[0]!.close({ obsolete: true });
    await b.connection.send({ protocol: "stream", type: "data", id: "collision", seq: 1, message: "B" });
    await drain();
    assert.deepEqual(await f.opened[1]!.readMessage(), { type: "data", seq: 1, message: "B" });
    assert.deepEqual(b.packets, []);
    await f.opened[1]!.close({ done: "B" });
    await drain();
    assert.deepEqual(b.packets, [{ protocol: "stream", type: "close", id: "collision", message: { done: "B" } }]);
});

test("same-process Stream without incoming Channel preserves its response route", { timeout: 5000 }, async (t) => {
    const endpoint = new Endpoint({ host: "local" });
    const server = new Stream(endpoint.bind("probe"));
    server.onOpen(async (stream, _name, _message, _peer, _local, incoming) => {
        assert.equal(incoming, undefined);
        await stream.close({ done: true });
    });
    const client = new Stream(await endpoint.connect("local", "probe"));
    t.after(() => { client.close(); server.close(); endpoint.close(); });
    const stream = await client.open("local");
    assert.deepEqual(await stream.readMessage(), { type: "close", message: { done: true } });
});
