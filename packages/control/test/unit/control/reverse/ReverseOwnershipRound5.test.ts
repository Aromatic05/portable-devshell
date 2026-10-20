import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";

import { ReverseConnections, type Instance } from "@portable-devshell/core";
import { ReverseSseChannel, asInstanceName, type Channel } from "@portable-devshell/shared";

function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

function fixture(t: TestContext, attach: (channel: Channel, generation: number, signal: AbortSignal) => Promise<void>) {
    let acquired = 0;
    let released = 0;
    const instance = {
        config: { name: asInstanceName("round5-owner"), provider: "reverse" },
        lifecycle: { acquireLease() {
            acquired += 1;
            return { instance, release() { released += 1; } };
        } },
        provision: { reverseConnection: {
            async attach(channel: Channel, input: { generation: number; signal: AbortSignal }) {
                await attach(channel, input.generation, input.signal);
            },
        } },
    } as unknown as Instance;
    const connections = new ReverseConnections({ instances: { get: () => instance } });
    t.after(() => connections.stop());
    const channel = () => {
        const received: string[] = [];
        const events = new EventEmitter();
        const response = Object.assign(events, {
            writableEnded: false,
            write() { return true; },
            end() { this.writableEnded = true; events.emit("close"); },
        });
        const value = new ReverseSseChannel(response as never);
        value.onData((bytes) => received.push(Buffer.from(bytes).toString()));
        t.after(() => value.close());
        return { value, received };
    };
    const identity = (generation: number) => ({ descriptor: instance, generation });
    const upload = (generation: number, seq: number, text: string) => connections.acceptUpstream(identity(generation), {
        generation, frames: [{ seq, frame: Buffer.from(text).toString("base64") }],
    });
    return { connections, channel, identity, upload, leases: () => ({ acquired, released }) };
}

test("Round5 pending SSE candidate owns only its generation and failure preserves predecessor routing", { timeout: 5_000 }, async (t) => {
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    const failure = new Error("Round5 candidate verification rejected");
    const f = fixture(t, async (_channel, generation) => {
        if (generation === 2) {
            entered.resolve();
            await release.promise;
            throw failure;
        }
    });
    const first = f.channel();
    const candidate = f.channel();
    await f.connections.activate(f.identity(1), "sse", first.value);
    const activation = f.connections.activate(f.identity(2), "sse", candidate.value);
    const rejected = assert.rejects(activation, (error: unknown) => error === failure);
    await entered.promise;
    assert.deepEqual(f.upload(1, 1, "old owner"), { acceptedThrough: 1, generation: 1 });
    assert.deepEqual(f.upload(2, 1, "candidate reply"), { acceptedThrough: 1, generation: 2 });
    assert.deepEqual(first.received, ["old owner"]);
    assert.deepEqual(candidate.received, ["candidate reply"]);
    release.resolve();
    await rejected;
    assert.equal(candidate.value.closed, true);
    assert.equal(first.value.closed, false);
    assert.throws(() => f.upload(2, 2, "retired"), { code: "reverse.connectionSuperseded" });
    assert.deepEqual(f.upload(1, 2, "still owned"), { acceptedThrough: 2, generation: 1 });
    assert.deepEqual(first.received, ["old owner", "still owned"]);
    assert.deepEqual(f.leases(), { acquired: 6, released: 6 });
});

test("Round5 SSE promotion isolates sequence counters and predecessor close cannot delete the new owner", async (t) => {
    const f = fixture(t, async () => {});
    const first = f.channel();
    const second = f.channel();
    await f.connections.activate(f.identity(7), "sse", first.value);
    f.upload(7, 1, "first");
    f.upload(7, 2, "second");
    await f.connections.activate(f.identity(8), "sse", second.value);
    assert.equal(first.value.closed, true);
    assert.equal(second.value.closed, false);
    assert.throws(() => f.upload(7, 3, "stale"), { code: "reverse.connectionSuperseded" });
    assert.deepEqual(f.upload(8, 1, "new"), { acceptedThrough: 1, generation: 8 });
    assert.deepEqual(f.upload(8, 1, "duplicate bytes must not be delivered"), { acceptedThrough: 1, generation: 8 });
    assert.throws(() => f.upload(8, 3, "gap"), /upstream sequence gap: expected 2, received 3/u);
    assert.deepEqual(f.upload(8, 2, "contiguous"), { acceptedThrough: 2, generation: 8 });
    assert.deepEqual(first.received, ["first", "second"]);
    assert.deepEqual(second.received, ["new", "contiguous"]);
    assert.equal(f.leases().acquired, f.leases().released);
});

test("Round5 disconnected candidate aborts verification and releases queued generation admission", { timeout: 5_000 }, async (t) => {
    const entered = barrier();
    const attached: number[] = [];
    const f = fixture(t, async (_channel, generation, signal) => {
        attached.push(generation);
        if (generation === 2) {
            entered.resolve();
            await new Promise<never>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
        }
    });
    const first = f.channel();
    const candidate = f.channel();
    const queued = f.channel();
    await f.connections.activate(f.identity(1), "sse", first.value);
    const activation = f.connections.activate(f.identity(2), "sse", candidate.value);
    const rejected = assert.rejects(activation, /Reverse candidate disconnected during handshake/u);
    await entered.promise;
    const next = f.connections.activate(f.identity(3), "sse", queued.value);
    assert.deepEqual(attached, [1, 2]);
    candidate.value.close();
    await rejected;
    await next;
    assert.deepEqual(attached, [1, 2, 3]);
    assert.equal(first.value.closed, true);
    assert.equal(candidate.value.closed, true);
    assert.equal(queued.value.closed, false);
    assert.deepEqual(f.upload(3, 1, "queued owner"), { acceptedThrough: 1, generation: 3 });
    assert.deepEqual(queued.received, ["queued owner"]);
    assert.deepEqual(f.leases(), { acquired: 4, released: 4 });
});

test("Round5 lower generation requires explicit credential replacement and subsequent admissions remain monotonic", async (t) => {
    const attached: number[] = [];
    const f = fixture(t, async (_channel, generation) => { attached.push(generation); });
    const first = f.channel();
    const stale = f.channel();
    const replacement = f.channel();
    const equal = f.channel();
    await f.connections.activate(f.identity(40), "sse", first.value);
    await assert.rejects(f.connections.activate(f.identity(1), "sse", stale.value), { code: "reverse.generationInvalid" });
    assert.equal(stale.value.closed, true);
    assert.equal(first.value.closed, false);
    await f.connections.activate(f.identity(1), "sse", replacement.value, { credentialReplacement: true });
    assert.equal(first.value.closed, true);
    assert.equal(replacement.value.closed, false);
    await assert.rejects(f.connections.activate(f.identity(1), "sse", equal.value), { code: "reverse.generationInvalid" });
    assert.deepEqual(attached, [40, 1]);
    assert.equal(equal.value.closed, true);
    assert.deepEqual(f.upload(1, 1, "replacement owner"), { acceptedThrough: 1, generation: 1 });
    assert.deepEqual(replacement.received, ["replacement owner"]);
    assert.deepEqual(f.leases(), { acquired: 5, released: 5 });
});
