import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { Endpoint, Stream, StreamChannel, type MessageStream } from "@portable-devshell/shared";
import { EventStreamReader, EventSubscription } from "../../../src/client/Stream.ts";
import { STREAM_QUEUE_MAX_BYTES, STREAM_QUEUE_MAX_MESSAGES } from "../../../src/transport/packet/Queue.ts";

const turn = async () => await new Promise<void>((resolve) => setImmediate(resolve));

test("closing a Stream protocol terminates remote subscriptions while the Channel remains live", async (t) => {
    const open = await fixture(t);
    const { local, remote } = await open();
    const reading = local.readMessage();
    // Model a route retiring a port without tearing down the common Channel.
    // The sender-side protocol must send a terminal packet, not only dispose locally.
    open.closeServer();
    await assert.rejects(reading, /Stream protocol closed/);
    await remote.close();
});

async function fixture(t: TestContext) {
    const up = new PassThrough(), down = new PassThrough();
    const client = new Endpoint({ host: "client", connectChannel: async () => new StreamChannel(down, up) });
    const server = new Endpoint({ host: "server" });
    const accepting = server.accept(new StreamChannel(up, down));
    const connection = await client.connect("server", "queue");
    await accepting;
    const sender = new Stream(connection), receiver = new Stream(server.bind("queue"));
    t.after(() => { sender.close(); receiver.close(); client.close(); server.close(); up.destroy(); down.destroy(); });
    return Object.assign(async () => {
        const opening = new Promise<MessageStream>((resolve) => {
            const off = receiver.onOpen((stream) => { off(); resolve(stream); });
        });
        const local = await sender.open("queue");
        return { local, remote: await opening };
    }, { closeServer: () => receiver.close() });
}

function events(stream: MessageStream) {
    return new EventStreamReader(stream, { decodeEvent: (payload) => payload, readGap: () => undefined });
}

async function healthy(local: MessageStream, remote: MessageStream) {
    await local.write(Uint8Array.of(1, 2, 3));
    assert.deepEqual(await remote.read(), Uint8Array.of(1, 2, 3));
}

test("Packet queue accepts exactly 8 MiB, releases consumed budget, then cancels overflow without harming sibling", { timeout: 10000 }, async (t) => {
    const open = await fixture(t);
    const slow = await open(), sibling = await open();
    const chunk = new Uint8Array(64 * 1024).fill(17);
    for (let i = 0; i < STREAM_QUEUE_MAX_BYTES / chunk.length; i++) await slow.local.write(chunk);
    await turn();
    assert.deepEqual(await slow.remote.read(), chunk);
    await slow.local.write(chunk);
    await turn();
    await healthy(sibling.local, sibling.remote);
    const cancelled = new Promise<void>((resolve) => slow.remote.onCancel((error) => {
        assert.equal(error?.code, "stream.queue_overflow");
        resolve();
    }));
    await slow.local.write(Uint8Array.of(99));
    await cancelled;
    await assert.rejects(slow.remote.read(), { code: "stream.queue_overflow" });
    await assert.rejects(slow.remote.read(), { code: "stream.queue_overflow" });
    await healthy(sibling.local, sibling.remote);
});

test("Packet count bounds empty messages and stalled async fanout deliveries", { timeout: 10000 }, async (t) => {
    const open = await fixture(t);
    const queued = await open();
    for (let i = 0; i < STREAM_QUEUE_MAX_MESSAGES; i++) await queued.local.send();
    await turn();
    assert.deepEqual(await queued.remote.readMessage(), { type: "data", seq: 1 });
    await queued.local.send();
    await queued.local.send();
    await turn();
    await assert.rejects(queued.remote.readMessage(), { code: "stream.queue_overflow" });

    const fanout = await open();
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    let seen = 0;
    fanout.remote.onData(async () => { seen++; await stalled; });
    fanout.remote.onData(() => { assert.fail("Cancellation must stop remaining fanout listeners"); });
    for (let i = 0; i <= STREAM_QUEUE_MAX_MESSAGES; i++) await fanout.local.send();
    await turn();
    assert.equal(seen, STREAM_QUEUE_MAX_MESSAGES);
    await assert.rejects(fanout.remote.readMessage(), { code: "stream.queue_overflow" });
    release();
    await turn();
});

test("Event reader stalls at bounded MessageStream count and sibling remains healthy", { timeout: 10000 }, async (t) => {
    const open = await fixture(t);
    const slow = await open(), sibling = await open();
    const reader = events(slow.remote);
    for (let i = 0; i <= STREAM_QUEUE_MAX_MESSAGES; i++) await slow.local.send({ name: "event", payload: i });
    await turn();
    const result = await reader.next();
    assert.ok(result.kind === "closed");
    assert.ok(result.error instanceof Error);
    assert.equal((result.error as Error & { code?: string }).code, "stream.queue_overflow");
    await healthy(sibling.local, sibling.remote);
});

test("oversize Event payload cancels even with an active next waiter", { timeout: 10000 }, async (t) => {
    const open = await fixture(t);
    const pair = await open();
    const reader = events(pair.remote);
    const pending = reader.next();
    await pair.local.send({ name: "event", payload: "x".repeat(STREAM_QUEUE_MAX_BYTES) });
    const result = await pending;
    assert.ok(result.kind === "closed");
    assert.ok(result.error instanceof Error);
    assert.equal((result.error as Error & { code?: string }).code, "stream.queue_overflow");
});

test("Event seed count is bounded; normal EOF drains seed and queued live events in order", { timeout: 10000 }, async (t) => {
    const open = await fixture(t);
    const oversized = await open();
    const overReader = events(oversized.remote);
    await oversized.local.send({ name: "seed", payload: { events: Array(STREAM_QUEUE_MAX_MESSAGES + 1).fill(0) } });
    const overflow = await overReader.next();
    assert.ok(overflow.kind === "closed");
    assert.equal((overflow.error as Error & { code?: string }).code, "stream.queue_overflow");
    const pair = await open();
    await pair.local.send({ name: "seed", payload: { events: [1, 2] } });
    await pair.local.send({ name: "event", payload: 3 });
    await pair.local.close();
    await turn();
    const reader = events(pair.remote);
    assert.deepEqual(await reader.next(), { kind: "event", event: 1 });
    assert.deepEqual(await reader.next(), { kind: "event", event: 2 });
    assert.deepEqual(await reader.next(), { kind: "event", event: 3 });
    assert.deepEqual(await reader.next(), { kind: "closed" });
});

test("Event explicit close wins a resolved-read race and disposes queued data; cancellation interrupts seed", { timeout: 10000 }, async (t) => {
    const open = await fixture(t);
    const pair = await open();
    const reader = events(pair.remote);
    const pending = reader.next();
    const delivering = pair.remote.acceptData(1, { name: "event", payload: 1 });
    reader.close();
    await delivering;
    assert.deepEqual(await pending, { kind: "closed" });
    assert.deepEqual(await reader.next(), { kind: "closed" });
    assert.deepEqual(await pair.remote.readMessage(), { type: "close" });

    const seeded = await open();
    const seedReader = events(seeded.remote);
    await seeded.local.send({ name: "seed", payload: { events: [1, 2] } });
    assert.deepEqual(await seedReader.next(), { kind: "event", event: 1 });
    await seeded.local.cancel({ message: "cancel seed", code: "test.cancel" });
    await turn();
    const cancelled = await seedReader.next();
    assert.ok(cancelled.kind === "closed");
    assert.equal(cancelled.error?.message, "cancel seed");
});

test("consuming concurrently supports transfers larger than the pending byte cap and preserves FIN ordering", { timeout: 10000 }, async (t) => {
    const open = await fixture(t);
    const pair = await open();
    let count = 0;
    const consuming = (async () => {
        for (;;) {
            const bytes = await pair.remote.read();
            if (bytes === undefined) break;
            assert.equal(bytes[0], 23);
            count += bytes.length;
        }
    })();
    await pair.local.write(new Uint8Array(STREAM_QUEUE_MAX_BYTES * 2).fill(23));
    await pair.local.finish();
    await consuming;
    assert.equal(count, STREAM_QUEUE_MAX_BYTES * 2);
    await pair.remote.write(Uint8Array.of(42));
    assert.deepEqual(await pair.local.read(), Uint8Array.of(42));
});

test("seed overflow remains an explicit error after remote CLOSE; close wakes all waiting consumers", { timeout: 10000 }, async (t) => {
    const open = await fixture(t);
    const seeded = await open();
    await seeded.local.send({ name: "seed", payload: { events: Array(STREAM_QUEUE_MAX_MESSAGES + 1).fill(0) } });
    await seeded.local.close();
    await turn();
    const reader = events(seeded.remote);
    const result = await reader.next();
    assert.ok(result.kind === "closed");
    assert.equal((result.error as Error & { code?: string }).code, "stream.queue_overflow");
    const waiting = await open();
    const waitReader = events(waiting.remote);
    const first = waitReader.next(), second = waitReader.next();
    waitReader.close();
    assert.deepEqual(await first, { kind: "closed" });
    assert.deepEqual(await second, { kind: "closed" });
});

test("onData replay consumes its byte/count budget and cancellation releases the pending remainder", { timeout: 10000 }, async (t) => {
    const open = await fixture(t);
    const pair = await open();
    for (let i = 0; i < STREAM_QUEUE_MAX_MESSAGES; i++) await pair.local.send(i);
    await turn();
    let received = 0;
    pair.remote.onData((value) => { assert.equal(value, received++); });
    await turn();
    assert.equal(received, STREAM_QUEUE_MAX_MESSAGES);
    await pair.local.send(STREAM_QUEUE_MAX_MESSAGES);
    await turn();
    assert.equal(received, STREAM_QUEUE_MAX_MESSAGES + 1);
    await pair.local.cancel({ message: "stop replay" });
    await turn();
    await assert.rejects(pair.remote.readMessage(), /stop replay/u);
});

test("Event overflow resubscribes from the last consumed cursor without inventing a gap", { timeout: 10000 }, async (t) => {
    const open = await fixture(t);
    const slow = await open(), recovered = await open();
    const reader = events(slow.remote);
    await slow.local.send({ name: "event", payload: 1 });
    assert.deepEqual(await reader.next(), { kind: "event", event: 1 });
    for (let i = 0; i <= STREAM_QUEUE_MAX_MESSAGES; i++) await slow.local.send({ name: "event", payload: i + 2 });
    await turn();
    await recovered.local.send({ name: "seed", payload: { events: [2, 3] } });
    const readers = [reader, events(recovered.remote)];
    const cursors: number[] = [], delivered: unknown[] = [];
    let progress!: () => void;
    const progressed = new Promise<void>((resolve) => { progress = resolve; });
    const subscription = new EventSubscription(2, {
        async open(cursor) {
            cursors.push(cursor);
            const next = readers.shift();
            assert.ok(next, "Unexpected extra resubscription");
            return next;
        },
        eventSeq: (event) => { assert.equal(typeof event, "number"); return event as number; },
        onEvent: (event) => { delivered.push(event); progress(); },
        onGap: () => { assert.fail("Overflow must reconnect using the consumed cursor"); },
        readGapError: () => undefined,
        retryBaseMs: 1,
    });
    t.after(() => subscription.stop());
    subscription.start();
    await progressed;
    await turn();
    assert.deepEqual(cursors, [2, 2]);
    assert.deepEqual(delivered, [2, 3]);
    assert.equal(subscription.cursor, 4);
    subscription.stop();
});
