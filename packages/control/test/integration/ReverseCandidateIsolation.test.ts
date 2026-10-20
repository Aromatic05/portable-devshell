import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import test, { type TestContext } from "node:test";

import { Instance, ReverseConnections } from "@portable-devshell/core";
import { normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import WebSocket, { WebSocketServer } from "ws";

import { InstanceRegistry } from "../../src/instance/Registry.ts";
import { ReverseCredentials } from "../../src/instance/reverse/Credentials.ts";
import { ReverseCredentialStore } from "../../src/instance/reverse/credential/Store.ts";
import { ReverseIngress } from "../../src/server/reverse/Ingress.ts";
import type { ReverseHttpHost } from "../../src/server/reverse/Api.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { barrier, ping, until, workerSession, type WorkerOptions } from "./ReverseNetworkRound6Fixture.ts";

// Replace only the physical WebSocket boundary. Ingress, authentication, disk
// credential commits, reliable frames, FrameProtocol and application RPC are real.
class Socket extends EventEmitter {
    readyState: number = WebSocket.OPEN;
    readonly protocol = "devshell-worker-transport.v2";
    peer!: Socket;
    dropNextAck = false;
    #fragments: Buffer[] = [];

    send(data: Uint8Array | string, options: { binary: boolean; fin?: boolean }, callback?: (error?: Error) => void) {
        setImmediate(() => {
            if (this.readyState !== WebSocket.OPEN || this.peer.readyState !== WebSocket.OPEN) {
                callback?.(new Error("Test WebSocket closed during write"));
                return;
            }
            if (!options.binary && String(data).startsWith("DSR2:") && data !== "DSR2:ready" && this.dropNextAck) {
                this.dropNextAck = false;
                callback?.();
                return;
            }
            this.#fragments.push(Buffer.from(data));
            if (options.fin !== false) {
                const message = Buffer.concat(this.#fragments);
                this.#fragments = [];
                this.peer.emit("message", message, options.binary);
            }
            callback?.();
        });
    }

    close(code = 1000, reason = "closed") {
        if (this.readyState === WebSocket.CLOSED) return;
        this.readyState = WebSocket.CLOSED;
        this.peer.readyState = WebSocket.CLOSED;
        setImmediate(() => {
            this.emit("close", code, Buffer.from(reason));
            this.peer.emit("close", code, Buffer.from(reason));
        });
    }

    terminate() { this.close(1006); }
    ping() { setImmediate(() => this.emit("pong")); }
}

class CommitBarrierStore extends ReverseCredentialStore {
    blockedToken?: string;
    readonly entered = barrier();
    readonly release = barrier();
    override async withAuthenticatedToken(instance: string, token: string, operation: (replacement: boolean) => Promise<void>) {
        return await super.withAuthenticatedToken(instance, token, async (replacement) => {
            await operation(replacement);
            if (token === this.blockedToken) {
                this.entered.resolve();
                await this.release.promise;
            }
        });
    }
}

async function fixture(t: TestContext) {
    const home = await createTestTempDirectory("reverse-candidate-isolation");
    const environment = { HOME: home, USERPROFILE: home, PORTABLE_DEVSHELL_HOME: `${home}/.devshell`, XDG_RUNTIME_DIR: home };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    Object.assign(process.env, environment);
    const instance = Instance.create(normalizeConfigInstanceDraft({ enabled: true, name: "r6-alpha", provider: "reverse" }));
    const registry = new InstanceRegistry([instance]);
    const store = new CommitBarrierStore(home);
    const connections = new ReverseConnections({ instances: registry });
    const credentials = new ReverseCredentials({ credentialStore: store, instanceRegistry: registry, publicBaseUrl: "http://test" });
    let upgrade!: Parameters<ReverseHttpHost["registerUpgradeHandler"]>[1];
    const ingress = new ReverseIngress({ connections, credentials, publicBaseUrl: "http://test" });
    ingress.install({
        registerRawRoute: () => () => {},
        registerUpgradeHandler: (_path, handler) => { upgrade = handler; return () => {}; },
    });
    t.mock.method(WebSocketServer.prototype, "handleUpgrade", (_request: unknown, socket: Socket, _head: unknown, callback: (socket: WebSocket) => void) => {
        callback(socket as unknown as WebSocket);
    });
    const workers: ReturnType<typeof workerSession>[] = [];
    t.after(async () => {
        store.release.resolve();
        connections.stop();
        for (const worker of workers) worker.socket.terminate();
        await Promise.all(workers.map((worker) => worker.closed));
        await Promise.all(workers.map((worker) => worker.serving));
        ingress.stop();
        await instance.close();
        for (const key of Object.keys(environment)) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
        await rm(home, { recursive: true, force: true });
    });
    const enroll = async () => (await store.consumeDeviceCode((await store.createDeviceCode("r6-alpha")).deviceCode)).deviceToken;
    const connect = async (token: string, generation: number, options: WorkerOptions = {}) => {
        const server = new Socket();
        const client = new Socket();
        server.peer = client;
        client.peer = server;
        const worker = workerSession(client as unknown as WebSocket, "r6-alpha", options);
        workers.push(worker);
        await upgrade({ headers: { authorization: `Bearer ${token}`, "x-devshell-instance": "r6-alpha", "x-devshell-generation": String(generation),
            "sec-websocket-protocol": "devshell-worker-transport.v2" } } as unknown as IncomingMessage, server as unknown as Duplex, Buffer.alloc(0));
        return { ...worker, dropNextAck: () => { server.dropNextAck = true; } };
    };
    return { home, instance, store, enroll, connect };
}

const options = { timeout: 8_000 };

test("R6-03 rejected higher generation keeps predecessor RPC sequence and credentials usable", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    const first = await f.connect(token, 1);
    await first.ready;
    assert.deepEqual(await ping(f.instance), { pong: true });
    const failed = await f.connect(token, 2, { failHandshake: true });
    await failed.closed;
    assert.equal(failed.acks.includes("DSR2:ready"), false);
    assert.equal(f.instance.supervision.snapshot().reverse?.generation, 1);
    assert.deepEqual(await ping(f.instance), { pong: true });
    assert.equal(await new ReverseCredentialStore(f.home).authenticate("r6-alpha", token), true);
    const retry = await f.connect(token, 2);
    await retry.ready;
    await first.closed;
    assert.deepEqual(await ping(f.instance), { pong: true });
});

for (const sameSession of [false, true]) {
    test(`R6-03 paused failed replacement isolates live ACKs with ${sameSession ? "reused" : "distinct"} session ID`, options, async (t) => {
        const f = await fixture(t);
        const session = randomBytes(16);
        const token = await f.enroll();
        const first = await f.connect(token, 15, { session, fragment: true, duplicate: true });
        await first.ready;
        const replacement = await f.enroll();
        const entered = barrier();
        const release = barrier();
        t.after(release.resolve);
        const failed = await f.connect(replacement, 1, { session: sameSession ? session : randomBytes(16), fragment: true, duplicate: true,
            handshake: async () => { entered.resolve(); await release.promise; }, failHandshake: true });
        await entered.promise;
        for (let index = 0; index < 3; index++) assert.deepEqual(await ping(f.instance), { pong: true });
        await until(() => first.acks.filter((ack) => ack !== "DSR2:ready").length === first.frames.length * 2);
        await first.replay(0);
        release.resolve();
        await failed.closed;
        assert.deepEqual(failed.methods, ["worker.ping", "worker.handshake"]);
        assert.equal(failed.acks.includes("DSR2:ready"), false);
        assert.deepEqual(await ping(f.instance), { pong: true });
        const reopened = new ReverseCredentialStore(f.home);
        assert.equal(await reopened.authenticate("r6-alpha", token), true);
        assert.equal(await reopened.authenticate("r6-alpha", replacement), true);
        const retry = await f.connect(replacement, 1, { session });
        await retry.ready;
        await first.closed;
        assert.equal(await reopened.authenticate("r6-alpha", token), false);
        assert.equal(await reopened.authenticate("r6-alpha", replacement), true);
        assert.deepEqual(await ping(f.instance), { pong: true });
        assert.deepEqual(retry.errors, []);
    });
}

test("R6-03 disconnect during handshake leaves predecessor usable until queued contender succeeds", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    const first = await f.connect(token, 1);
    await first.ready;
    const entered = barrier();
    const release = barrier();
    const nextEntered = barrier();
    const nextRelease = barrier();
    t.after(() => { release.resolve(); nextRelease.resolve(); });
    const slow = await f.connect(token, 2, { handshake: async () => { entered.resolve(); await release.promise; } });
    await entered.promise;
    const next = await f.connect(token, 3, { handshake: async () => { nextEntered.resolve(); await nextRelease.promise; } });
    assert.deepEqual(next.methods, []);
    assert.deepEqual(await ping(f.instance), { pong: true });
    slow.socket.close();
    await slow.closed;
    await nextEntered.promise;
    assert.deepEqual(await ping(f.instance), { pong: true });
    nextRelease.resolve();
    await next.ready;
    await first.closed;
    release.resolve();
    assert.equal(slow.acks.includes("DSR2:ready"), false);
    assert.equal(f.instance.supervision.snapshot().reverse?.generation, 3);
    assert.deepEqual(await ping(f.instance), { pong: true });
});

test("R6-03 candidate gap after admitted frames closes only candidate and preserves predecessor watermark", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    const first = await f.connect(token, 3);
    await first.ready;
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    const candidate = await f.connect(token, 4, { handshake: async () => { entered.resolve(); await release.promise; } });
    await entered.promise;
    candidate.inject(candidate.frames.length + 2);
    await candidate.closed;
    assert.equal(candidate.acks.includes("DSR2:ready"), false);
    await first.replay(0);
    assert.deepEqual(await ping(f.instance), { pong: true });
    assert.equal(f.instance.supervision.snapshot().reverse?.generation, 3);
    release.resolve();
    const retry = await f.connect(token, 4, { fragment: true, duplicate: true });
    await retry.ready;
    await first.closed;
    assert.deepEqual(await ping(f.instance), { pong: true });
    await until(() => retry.acks.filter((ack) => ack !== "DSR2:ready").length === retry.frames.length * 2);
    assert.equal(retry.frames[0]!.readBigUInt64BE(20), 1n);
});

test("R6-03 successful takeover retires predecessor after handshake and READY follows persisted credential activation", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    const first = await f.connect(token, 20);
    await first.ready;
    const replacement = await f.enroll();
    f.store.blockedToken = replacement;
    const next = await f.connect(replacement, 1);
    await f.store.entered.promise;
    await first.closed;
    assert.deepEqual(next.methods.slice(0, 2), ["worker.ping", "worker.handshake"]);
    assert.equal(f.instance.supervision.snapshot().reverse?.generation, 1);
    assert.equal(next.acks.includes("DSR2:ready"), false);
    const reopened = new ReverseCredentialStore(f.home);
    assert.equal(await reopened.authenticate("r6-alpha", token), true);
    assert.equal(await reopened.authenticate("r6-alpha", replacement), true);
    const queued = await f.connect(token, 21);
    assert.deepEqual(queued.methods, []);
    f.store.release.resolve();
    await next.ready;
    await queued.closed;
    assert.deepEqual(queued.methods, []);
    assert.equal(queued.acks.includes("DSR2:ready"), false);
    assert.equal(await reopened.authenticate("r6-alpha", token), false);
    assert.equal(await reopened.authenticate("r6-alpha", replacement), true);
    assert.deepEqual(await ping(f.instance), { pong: true });
});

test("R6-03 session changes cannot reset candidate sequence or interfere with predecessor", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    const first = await f.connect(token, 1);
    await first.ready;
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    const candidate = await f.connect(token, 2, { handshake: async () => { entered.resolve(); await release.promise; } });
    await entered.promise;
    const foreign = Buffer.from(candidate.frames[0]!);
    randomBytes(16).copy(foreign, 4);
    await until(() => candidate.acks.length === candidate.frames.length);
    const count = candidate.acks.length;
    candidate.socket.send(foreign, { binary: true });
    await candidate.closed;
    assert.equal(candidate.acks.length, count);
    assert.equal(candidate.acks.includes("DSR2:ready"), false);
    assert.deepEqual(await ping(f.instance), { pong: true });
    release.resolve();
    const retry = await f.connect(token, 2);
    await retry.ready;
    await first.closed;
    assert.deepEqual(await ping(f.instance), { pong: true });
});

test("R6-03 rejected initial sequence cannot consume generation or predecessor ACK watermark", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    const first = await f.connect(token, 1);
    await first.ready;
    const bad = await f.connect(token, 2, { firstSequence: 2 });
    await bad.closed;
    assert.deepEqual(bad.acks, []);
    assert.equal(f.instance.supervision.snapshot().reverse?.generation, 1);
    assert.deepEqual(await ping(f.instance), { pong: true });
    const retry = await f.connect(token, 2);
    await retry.ready;
    await first.closed;
    assert.deepEqual(await ping(f.instance), { pong: true });
});

test("R6-03 handshake timeout retains predecessor RPC and both credentials before successful retry", { timeout: 30_000 }, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    const first = await f.connect(token, 10);
    await first.ready;
    const replacement = await f.enroll();
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    const started = performance.now();
    const slow = await f.connect(replacement, 1, { handshake: async () => { entered.resolve(); await release.promise; } });
    await entered.promise;
    assert.deepEqual(await ping(f.instance), { pong: true });
    await slow.closed;
    assert.ok(performance.now() - started >= 19_000, "exercise the actual admission timeout");
    assert.equal(slow.acks.includes("DSR2:ready"), false);
    assert.equal(f.instance.supervision.snapshot().reverse?.generation, 10);
    assert.deepEqual(await ping(f.instance), { pong: true });
    const reopened = new ReverseCredentialStore(f.home);
    assert.equal(await reopened.authenticate("r6-alpha", token), true);
    assert.equal(await reopened.authenticate("r6-alpha", replacement), true);
    release.resolve();
    const retry = await f.connect(replacement, 1);
    await retry.ready;
    await first.closed;
    assert.equal(await reopened.authenticate("r6-alpha", token), false);
    assert.deepEqual(await ping(f.instance), { pong: true });
});

test("R6-03 lost ACK and delayed replay during candidate handshake do not redeliver predecessor RPC", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    const first = await f.connect(token, 1);
    await first.ready;
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    const candidate = await f.connect(token, 2, { handshake: async () => { entered.resolve(); await release.promise; }, failHandshake: true });
    await entered.promise;
    first.dropNextAck();
    const ackCount = first.acks.length;
    assert.deepEqual(await ping(f.instance), { pong: true });
    const latest = first.frames.length - 1;
    await first.replay(latest);
    await until(() => first.acks.length === ackCount + 1);
    assert.equal(first.acks.at(-1), `DSR2:${first.frames[latest]!.subarray(4, 20).toString("hex")}:${latest + 1}`);
    release.resolve();
    await candidate.closed;
    assert.deepEqual(await ping(f.instance), { pong: true });
    assert.deepEqual(first.methods, ["worker.ping", "worker.handshake", "tools.list", "worker.ping", "worker.ping"]);
    assert.deepEqual(first.errors, []);
});

test("R6-03 concurrent contenders serialize promotion and reject equal generation without affecting the winner", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    const session = randomBytes(16);
    const first = await f.connect(token, 1, { session });
    await first.ready;
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    const winner = await f.connect(token, 2, { session, handshake: async () => { entered.resolve(); await release.promise; } });
    await entered.promise;
    const equal = await f.connect(token, 2, { session });
    const newest = await f.connect(token, 3, { session });
    assert.deepEqual(equal.methods, []);
    assert.deepEqual(newest.methods, []);
    assert.deepEqual(await ping(f.instance), { pong: true });
    release.resolve();
    await winner.ready;
    await equal.closed;
    await newest.ready;
    await Promise.all([first.closed, winner.closed]);
    assert.deepEqual(equal.methods, []);
    assert.equal(equal.acks.includes("DSR2:ready"), false);
    assert.equal(f.instance.supervision.snapshot().reverse?.generation, 3);
    assert.deepEqual(await ping(f.instance), { pong: true });
    assert.deepEqual(newest.errors, []);
});
