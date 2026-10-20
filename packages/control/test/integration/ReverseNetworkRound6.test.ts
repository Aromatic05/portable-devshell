import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";

import WebSocket from "ws";

import { ReverseCredentialStore } from "../../src/instance/reverse/credential/Store.ts";
import { barrier, fixture, headers, ping, post, sse, until, type UpstreamFrame } from "./ReverseNetworkRound6Fixture.ts";

const options = { timeout: 10_000 };

test("Round6 WSS physical continuation fragments and duplicate reliable records complete real RPC", options, async (t) => {
    const f = await fixture(t);
    const worker = f.connect(await f.enroll(), 1, { fragment: true, duplicate: true });
    await worker.ready;
    assert.deepEqual(await ping(f.alpha), { pong: true });
    assert.deepEqual(worker.methods, ["worker.ping", "worker.handshake", "tools.list", "worker.ping"]);
    await until(() => worker.acks.filter((ack) => ack !== "DSR2:ready").length === worker.frames.length * 2);
    const acknowledgements = worker.acks.filter((ack) => ack !== "DSR2:ready");
    assert.ok(worker.frames.length >= 4);
    for (let index = 0; index < acknowledgements.length; index += 2) {
        assert.equal(acknowledgements[index], acknowledgements[index + 1]);
    }
    assert.deepEqual(worker.errors, []);
    assert.equal(f.alpha.supervision.snapshot().ready, true);
});

test("Round6 WSS replay of old sequences after newer ACKs does not redeliver RPC bytes", options, async (t) => {
    const f = await fixture(t);
    const worker = f.connect(await f.enroll(), 9);
    await worker.ready;
    const count = worker.acks.length;
    await worker.replay(2);
    await worker.replay(0);
    await worker.replay(1);
    await until(() => worker.acks.length === count + 3);
    assert.deepEqual(await ping(f.alpha), { pong: true });
    assert.deepEqual(worker.methods, ["worker.ping", "worker.handshake", "tools.list", "worker.ping"]);
    assert.equal(worker.socket.readyState, WebSocket.OPEN);
    assert.deepEqual(worker.errors, []);
});

test("Round6 WSS new session starting out of order fails without consuming the candidate generation", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    const first = f.connect(token, 3);
    await first.ready;
    const invalid = f.connect(token, 4, { firstSequence: 2 });
    await invalid.closed;
    assert.equal(invalid.acks.includes("DSR2:ready"), false);
    assert.equal(first.socket.readyState, WebSocket.OPEN);
    assert.equal(f.alpha.supervision.snapshot().reverse?.generation, 3);
    assert.deepEqual(await ping(f.alpha), { pong: true });
    const retry = f.connect(token, 4);
    await retry.ready;
    await first.closed;
    assert.deepEqual(await ping(f.alpha), { pong: true });
    assert.equal(f.alpha.supervision.snapshot().reverse?.generation, 4);
});

test("Round6 WSS gap after acknowledged RPC closes only its owner and reconnect starts a fresh reliable session", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    const first = f.connect(token, 6);
    const beta = f.connect(await f.enroll("r6-beta"), 1, {}, "r6-beta");
    await Promise.all([first.ready, beta.ready]);
    assert.deepEqual(await ping(f.alpha), { pong: true });
    const gapSequence = first.frames.length + 2;
    first.inject(gapSequence);
    await first.closed;
    await until(() => !f.alpha.supervision.snapshot().ready);
    assert.equal(first.acks.some((ack) => ack.endsWith(`:${gapSequence}`)), false);
    assert.deepEqual(await ping(f.beta), { pong: true });
    const reconnected = f.connect(token, 7);
    await reconnected.ready;
    assert.deepEqual(await ping(f.alpha), { pong: true });
    assert.equal(reconnected.frames[0]!.readBigUInt64BE(20), 1n);
    assert.notDeepEqual(reconnected.frames[0]!.subarray(4, 20), first.frames[0]!.subarray(4, 20));
    assert.equal(f.alpha.supervision.snapshot().reverse?.generation, 7);
    assert.deepEqual(reconnected.errors, []);
});

test("Round6 WSS credentials cannot be replayed against another instance while both routes remain live", options, async (t) => {
    const f = await fixture(t);
    const alpha = await f.enroll();
    const beta = await f.enroll("r6-beta");
    const a = f.connect(alpha, 1);
    const b = f.connect(beta, 1, {}, "r6-beta");
    await Promise.all([a.ready, b.ready]);
    const impostor = f.connect(alpha, 50, {}, "r6-beta");
    await impostor.closed;
    assert.deepEqual(impostor.methods, []);
    assert.ok(impostor.errors.includes("Unexpected server response: 401"));
    assert.deepEqual(await ping(f.alpha), { pong: true });
    assert.deepEqual(await ping(f.beta), { pong: true });
    assert.equal(f.beta.supervision.snapshot().reverse?.generation, 1);
});

test("Round6 real slow WSS handshake times out while another instance activates and predecessor credentials survive", { timeout: 30_000 }, async (t) => {
    const f = await fixture(t);
    const old = await f.enroll();
    const first = f.connect(old, 11);
    await first.ready;
    const replacement = await f.enroll();
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    const started = performance.now();
    const slow = f.connect(replacement, 1, { handshake: async () => { entered.resolve(); await release.promise; } });
    await entered.promise;
    const beta = f.connect(await f.enroll("r6-beta"), 1, {}, "r6-beta");
    await beta.ready;
    assert.deepEqual(await ping(f.beta), { pong: true });
    await slow.closed;
    assert.ok(performance.now() - started >= 19_000, "exercise the real 20-second admission timeout");
    assert.equal(slow.acks.includes("DSR2:ready"), false);
    assert.equal(first.socket.readyState, WebSocket.OPEN);
    assert.equal(f.alpha.supervision.snapshot().reverse?.generation, 11);
    const reopened = new ReverseCredentialStore(f.home);
    assert.equal(await reopened.authenticate("r6-alpha", old), true);
    assert.equal(await reopened.authenticate("r6-alpha", replacement), true);
    release.resolve();
    const retry = f.connect(replacement, 1);
    await retry.ready;
    await first.closed;
    assert.deepEqual(await ping(f.alpha), { pong: true });
    assert.equal(await reopened.authenticate("r6-alpha", old), false);
});

test("Round6 closing a blocked WSS candidate releases queued admission without blocking a second instance", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    const first = f.connect(token, 1);
    await first.ready;
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    const slow = f.connect(token, 2, { handshake: async () => { entered.resolve(); await release.promise; } });
    await entered.promise;
    const queued = f.connect(token, 3);
    const beta = f.connect(await f.enroll("r6-beta"), 1, {}, "r6-beta");
    await beta.ready;
    assert.deepEqual(queued.methods, []);
    slow.socket.close();
    await slow.closed;
    await queued.ready;
    await first.closed;
    release.resolve();
    assert.deepEqual(await ping(f.alpha), { pong: true });
    assert.deepEqual(await ping(f.beta), { pong: true });
    assert.equal(f.alpha.supervision.snapshot().reverse?.generation, 3);
    assert.equal(slow.acks.includes("DSR2:ready"), false);
});

test("Round6 SSE fragmented FrameProtocol bytes in chunked JSON POSTs preserve downstream event watermark", options, async (t) => {
    const f = await fixture(t);
    const stream = await sse(t, f.base, await f.enroll(), 1, undefined, 300);
    await until(() => f.alpha.supervision.snapshot().ready);
    assert.deepEqual(await ping(f.alpha), { pong: true });
    assert.deepEqual(stream.methods, ["worker.ping", "worker.handshake", "tools.list", "worker.ping"]);
    assert.ok(stream.sequence() >= 12, "each RPC response crosses at least three upstream byte fragments");
    assert.ok(stream.ids.length >= 4);
    assert.deepEqual(stream.ids, stream.ids.map((_id, index) => 301 + index));
    assert.deepEqual(stream.errors, []);
});

async function interruptedPost(base: string, token: string, frames: UpstreamFrame[]) {
    const body = JSON.stringify({ generation: 1, frames });
    await new Promise<void>((resolve, reject) => {
        const req = request(`${base}/frames`, { method: "POST", headers: { ...headers(token, 1), "content-length": String(Buffer.byteLength(body)) } });
        req.once("error", (error: NodeJS.ErrnoException) => {
            assert.equal(error.code, "ECONNRESET");
            resolve();
        });
        req.once("response", () => reject(new Error("truncated POST must not produce a successful response")));
        // The complete first frame exists in the prefix, but the enclosing JSON is incomplete.
        req.write(body.slice(0, body.lastIndexOf("}")), () => {
            setTimeout(() => req.destroy(), 30);
        });
    });
}

test("Round6 interrupted SSE POST cannot partially deliver a valid frame prefix or advance its ACK", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    let interrupted = 0;
    const stream = await sse(t, f.base, token, 1, async (frames) => {
        if (interrupted === 0) {
            interrupted += 1;
            await interruptedPost(f.base, token, frames);
            const probe = await post(f.base, token, 1, []);
            assert.equal(probe.status, 200);
            assert.deepEqual(await probe.json(), { acceptedThrough: 0, generation: 1 });
        }
        const retry = await post(f.base, token, 1, frames);
        assert.equal(retry.status, 200);
        assert.deepEqual(await retry.json(), { acceptedThrough: frames.at(-1)!.seq, generation: 1 });
    });
    await until(() => f.alpha.supervision.snapshot().ready);
    assert.deepEqual(await ping(f.alpha), { pong: true });
    assert.equal(interrupted, 1);
    assert.deepEqual(stream.errors, []);
});

test("Round6 SSE partial batch with sequence disorder retains contiguous prefix and retry completes RPC", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    let disordered = 0;
    const stream = await sse(t, f.base, token, 1, async (frames) => {
        if (disordered === 0) {
            disordered += 1;
            assert.equal(frames.length, 3);
            const gap = await post(f.base, token, 1, [frames[0]!, frames[2]!]);
            assert.equal(gap.status, 400);
            assert.match(((await gap.json()) as { error: { message: string } }).error.message, /expected 2, received 3/u);
            const probe = await post(f.base, token, 1, []);
            assert.deepEqual(await probe.json(), { acceptedThrough: 1, generation: 1 });
        }
        const replay = await post(f.base, token, 1, frames);
        assert.equal(replay.status, 200);
        assert.deepEqual(await replay.json(), { acceptedThrough: frames.at(-1)!.seq, generation: 1 });
    });
    await until(() => f.alpha.supervision.snapshot().ready);
    assert.deepEqual(await ping(f.alpha), { pong: true });
    assert.equal(disordered, 1);
    assert.deepEqual(stream.errors, []);
});

test("Round6 SSE upload opened before WSS promotion cannot route its delayed body into the new generation", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    const stream = await sse(t, f.base, token, 1);
    await until(() => f.alpha.supervision.snapshot().ready);
    const body = JSON.stringify({ generation: 1, frames: [] });
    let req!: ReturnType<typeof request>;
    const sent = barrier();
    const delayed = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        req = request(`${f.base}/frames`, { method: "POST", headers: { ...headers(token, 1), "content-length": String(Buffer.byteLength(body)) } }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) as unknown }));
        });
        req.on("error", reject);
        req.flushHeaders();
        req.write(body.slice(0, 10), sent.resolve);
    });
    t.after(() => req.destroy());
    await sent.promise;
    const successor = f.connect(token, 2);
    await successor.ready;
    await stream.pumping;
    req.end(body.slice(10));
    assert.deepEqual(await delayed, { status: 409, body: { error: {
        code: "reverse.connectionSuperseded", message: "SSE connection is not the active generation.",
    } } });
    assert.deepEqual(await ping(f.alpha), { pong: true });
    assert.equal(f.alpha.supervision.snapshot().reverse?.generation, 2);
});

test("Round6 reenrollment during blocked WSS credential commit suppresses obsolete READY and admits the newest credential", options, async (t) => {
    const f = await fixture(t);
    const first = f.connect(await f.enroll(), 10);
    await first.ready;
    const intermediate = await f.enroll();
    f.store.blockedToken = intermediate;
    const blocked = f.connect(intermediate, 1);
    await f.store.entered.promise;
    await first.closed;
    const latest = await f.enroll();
    const next = f.connect(latest, 1);
    const beta = f.connect(await f.enroll("r6-beta"), 1, {}, "r6-beta");
    await beta.ready;
    assert.equal(blocked.acks.includes("DSR2:ready"), false);
    assert.deepEqual(next.methods, []);
    f.store.release.resolve();
    await blocked.closed;
    await next.ready;
    assert.equal(blocked.acks.includes("DSR2:ready"), false);
    const reopened = new ReverseCredentialStore(f.home);
    assert.equal(await reopened.authenticate("r6-alpha", intermediate), false);
    assert.equal(await reopened.authenticate("r6-alpha", latest), true);
    assert.deepEqual(await ping(f.alpha), { pong: true });
    assert.deepEqual(await ping(f.beta), { pong: true });
});
