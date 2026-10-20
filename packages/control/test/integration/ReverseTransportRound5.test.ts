import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import test, { type TestContext } from "node:test";

import { Instance, ReverseConnections } from "@portable-devshell/core";
import { HttpHost } from "@portable-devshell/mcp/testing";
import { Endpoint, Rpc, WORKER_PROTOCOL_VERSION, normalizeConfigInstanceDraft, type Channel, type JsonValue } from "@portable-devshell/shared";
import WebSocket from "ws";

import { InstanceRegistry } from "../../src/instance/Registry.ts";
import { ReverseCredentials } from "../../src/instance/reverse/Credentials.ts";
import { ReverseCredentialStore } from "../../src/instance/reverse/credential/Store.ts";
import { ReverseIngress } from "../../src/server/reverse/Ingress.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

// Pause only after the real admission operation returns, before the real
// credential store commits rollover. No transport or admission result is mocked.
class CommitBarrierStore extends ReverseCredentialStore {
    blockedToken?: string;
    readonly entered = barrier();
    readonly release = barrier();
    override async withAuthenticatedToken(
        instance: string,
        token: string,
        operation: (replacement: boolean) => Promise<void>,
    ): Promise<boolean> {
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
    const home = await createTestTempDirectory("reverse-transport-round5");
    const instance = Instance.create(normalizeConfigInstanceDraft({
        enabled: true, name: "reverse-test", provider: "reverse",
    }));
    const registry = new InstanceRegistry([instance]);
    const store = new CommitBarrierStore(home);
    const connections = new ReverseConnections({ instances: registry });
    const credentials = new ReverseCredentials({
        credentialStore: store, instanceRegistry: registry, publicBaseUrl: "http://127.0.0.1/base",
    });
    credentials.setDisconnectHandler((name) => connections.disconnect(name));
    const server = new HttpHost({ listenHost: "127.0.0.1", listenPort: 0, publicBaseUrl: "http://127.0.0.1/base" });
    const ingress = new ReverseIngress({ connections, credentials, publicBaseUrl: "http://127.0.0.1/base" });
    const workers: ReturnType<typeof connectWorker>[] = [];
    t.after(async () => {
        store.release.resolve();
        connections.stop();
        for (const worker of workers) worker.socket.close();
        await Promise.all(workers.map((worker) => worker.closed));
        ingress.stop();
        await server.stop();
        await rm(home, { recursive: true, force: true });
    });
    ingress.install(server);
    await server.start();
    assert.ok(server.address && typeof server.address === "object");
    const port = server.address.port;
    const enroll = async () => (await store.consumeDeviceCode((await store.createDeviceCode("reverse-test")).deviceCode)).deviceToken;
    const connect = (token: string, generation: number, failHandshake = false) => {
        const worker = connectWorker(port, token, generation, "v2", failHandshake);
        workers.push(worker);
        return worker;
    };
    return { home, instance, store, connections, port, enroll, connect };
}

const options = { timeout: 8_000 };

test("Round5 WSS READY is a credential commit barrier even when instance readiness is already visible", options, async (t) => {
    const f = await fixture(t);
    const oldToken = await f.enroll();
    const first = f.connect(oldToken, 17);
    await first.ready;
    const replacementToken = await f.enroll();
    f.store.blockedToken = replacementToken;
    const replacement = f.connect(replacementToken, 1);
    await f.store.entered.promise;
    await first.closed;
    assert.equal(f.instance.supervision.snapshot().ready, true);
    assert.equal(f.instance.supervision.snapshot().reverse?.generation, 1);
    assert.equal(replacement.acks.includes("ready"), false);
    assert.equal(await f.store.authenticate("reverse-test", oldToken), true);
    assert.equal(await f.store.authenticate("reverse-test", replacementToken), true);
    f.store.release.resolve();
    await replacement.ready;
    assert.equal(await f.store.authenticate("reverse-test", oldToken), false);
    assert.equal(await new ReverseCredentialStore(f.home).authenticate("reverse-test", oldToken), false);
    assert.equal(await f.store.authenticate("reverse-test", replacementToken), true);
    assert.ok(replacement.methods.includes("worker.ping"), "WSS must ping the admitted Worker");
    assert.ok(replacement.methods.includes("worker.handshake"), "WSS must complete an actual Worker handshake");
    assert.ok(replacement.methods.every((method) => ["worker.ping", "worker.handshake", "tools.list"].includes(method)),
        "WSS should not invoke unsupported Worker methods");
    assert.deepEqual(replacement.errors, []);
    const rejected = await fetch(`http://127.0.0.1:${f.port}/base/reverse/v1/frames`, {
        method: "POST", headers: authHeaders(oldToken, 1),
        body: JSON.stringify({ generation: 1, frames: [] }),
    });
    assert.equal(rejected.status, 401);
    assert.equal(((await rejected.json()) as { error: { code: string } }).error.code, "reverse.deviceTokenInvalid");
});

test("Round5 failed WSS replacement retains predecessor ownership and permits lower generation retry", options, async (t) => {
    const f = await fixture(t);
    const oldToken = await f.enroll();
    const first = f.connect(oldToken, 30);
    await first.ready;
    const replacementToken = await f.enroll();
    const failed = f.connect(replacementToken, 1, true);
    await failed.closed;
    assert.deepEqual(failed.methods, ["worker.ping", "worker.handshake"]);
    assert.equal(failed.acks.includes("ready"), false);
    assert.equal(first.socket.readyState, WebSocket.OPEN);
    assert.equal(f.instance.supervision.snapshot().ready, true);
    assert.equal(f.instance.supervision.snapshot().reverse?.generation, 30);
    assert.equal(await f.store.authenticate("reverse-test", oldToken), true);
    assert.equal(await f.store.authenticate("reverse-test", replacementToken), true);
    const retry = f.connect(replacementToken, 1);
    await retry.ready;
    await first.closed;
    assert.equal(f.instance.supervision.snapshot().reverse?.generation, 1);
    assert.equal(await f.store.authenticate("reverse-test", oldToken), false);
    assert.deepEqual(retry.errors, []);
});

test("Round5 WSS churn keeps current generation owned after predecessor close and rejects equal generations", options, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    let current = f.connect(token, 1);
    await current.ready;
    for (let generation = 2; generation <= 16; generation += 1) {
        const previous = current;
        current = f.connect(token, generation);
        await current.ready;
        await previous.closed;
        assert.equal(current.socket.readyState, WebSocket.OPEN);
        assert.equal(f.instance.supervision.snapshot().ready, true);
        assert.equal(f.instance.supervision.snapshot().reverse?.generation, generation);
        assert.ok(current.methods.includes("worker.ping"), "WSS must ping the admitted Worker");
    assert.ok(current.methods.includes("worker.handshake"), "WSS must complete an actual Worker handshake");
    assert.ok(current.methods.every((method) => ["worker.ping", "worker.handshake", "tools.list"].includes(method)),
        "WSS should not invoke unsupported Worker methods");
        assert.deepEqual(current.errors, []);
    }
    const stale = f.connect(token, 16);
    await stale.closed;
    assert.deepEqual(stale.methods, []);
    assert.equal(stale.acks.includes("ready"), false);
    assert.equal(current.socket.readyState, WebSocket.OPEN);
    assert.equal(f.instance.supervision.snapshot().reverse?.generation, 16);
    f.connections.disconnect("reverse-test");
    await current.closed;
    await waitUntil(() => f.instance.supervision.snapshot().reverse?.availability === "offline");
    // Supervision retains the generation watermark across disconnect; only a
    // newly enrolled credential authorizes restarting its counter.
    const rewind = f.connect(token, 1);
    await rewind.closed;
    assert.deepEqual(rewind.methods, []);
    assert.equal(rewind.acks.includes("ready"), false);
    const newToken = await f.enroll();
    const restarted = f.connect(newToken, 1);
    await restarted.ready;
    assert.equal(f.instance.supervision.snapshot().ready, true);
    assert.equal(f.instance.supervision.snapshot().reverse?.generation, 1);
    assert.equal(await f.store.authenticate("reverse-test", token), false);
});

test("Round5 SSE concurrent duplicate POSTs survive gaps and cannot cross generation ownership", options, async (t) => {
    const f = await fixture(t);
    const predecessor = await f.enroll();
    const token = await f.enroll();
    f.store.blockedToken = token;
    const headers = authHeaders(token, 4);
    const response = await fetch(`http://127.0.0.1:${f.port}/base/reverse/v1/events`, { headers });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const methods: string[] = [];
    const errors: unknown[] = [];
    const uploads: Promise<void>[] = [];
    let sequence = 0;
    let lastFrame = "";
    const post = async (generation: number, frames: { seq: number; frame: string }[], requestGeneration = 4) => {
        return await fetch(`http://127.0.0.1:${f.port}/base/reverse/v1/frames`, {
            method: "POST", headers: authHeaders(token, requestGeneration),
            body: JSON.stringify({ generation, frames }),
        });
    };
    const channel = new TestWorkerChannel(async (data) => {
        const seq = ++sequence;
        lastFrame = Buffer.from(data).toString("base64");
        const frame = lastFrame;
        const upload = (async () => {
            // Both requests carry exactly the same bytes. Either arrival order
            // must deliver only once and return the same contiguous ACK.
            const replies = await Promise.all([post(4, [{ seq, frame }]), post(4, [{ seq, frame }])]);
            for (const reply of replies) {
                assert.equal(reply.status, 200);
                assert.deepEqual(await reply.json(), { acceptedThrough: seq, generation: 4 });
            }
        })();
        uploads.push(upload);
        await upload;
    }, () => undefined);
    const serving = serveWorkerEndpoint(channel, methods).catch((error: unknown) => { errors.push(error); });
    const pumping = (async () => {
        let buffered = "";
        const decoder = new TextDecoder();
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return;
            buffered += decoder.decode(chunk.value, { stream: true });
            let boundary = buffered.indexOf("\n\n");
            while (boundary >= 0) {
                const event = buffered.slice(0, boundary);
                buffered = buffered.slice(boundary + 2);
                const data = event.split("\n").find((line) => line.startsWith("data:"));
                if (data !== undefined) channel.emit(Buffer.from(data.slice(5).trim(), "base64"));
                boundary = buffered.indexOf("\n\n");
            }
        }
    })();
    t.after(async () => {
        await reader.cancel();
        channel.finish();
        await pumping;
        await serving;
    });
    await f.store.entered.promise;
    await Promise.all(uploads);
    assert.ok(sequence >= 3, "handshake must send real upstream RPC replies");
    assert.deepEqual(methods, ["worker.ping", "worker.handshake", "tools.list"]);
    assert.equal(await f.store.authenticate("reverse-test", predecessor), true);
    const gap = await post(4, [{ seq: sequence + 2, frame: lastFrame }]);
    assert.equal(gap.status, 400);
    assert.equal(((await gap.json()) as { error: { message: string } }).error.message,
        `upstream sequence gap: expected ${sequence + 1}, received ${sequence + 2}`);
    const mismatched = await post(5, []);
    assert.equal(mismatched.status, 409);
    assert.equal(((await mismatched.json()) as { error: { code: string } }).error.code, "reverse.generationInvalid");
    const wrongOwner = await post(5, [], 5);
    assert.equal(wrongOwner.status, 409);
    assert.equal(((await wrongOwner.json()) as { error: { code: string } }).error.code, "reverse.connectionSuperseded");
    const replay = await post(4, [{ seq: sequence, frame: lastFrame }]);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { acceptedThrough: sequence, generation: 4 });
    f.store.release.resolve();
    // Credential persistence is the observable SSE admission completion boundary.
    await waitUntilAsync(async () => !(await f.store.authenticate("reverse-test", predecessor)));
    assert.equal(f.instance.supervision.snapshot().reverse?.transport, "sse");
    const replacement = f.connect(token, 5);
    await replacement.ready;
    await pumping;
    const retired = await post(4, [{ seq: sequence, frame: lastFrame }]);
    assert.equal(retired.status, 409);
    assert.equal(((await retired.json()) as { error: { code: string } }).error.code, "reverse.connectionSuperseded");
    assert.equal(f.instance.supervision.snapshot().reverse?.generation, 5);
    assert.deepEqual(errors, []);
});

async function waitUntilAsync(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = performance.now() + 2_000;
    while (!(await predicate())) {
        assert.ok(performance.now() < deadline, "reverse credential commit boundary was not reached");
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

function authHeaders(token: string, generation: number) {
    return {
        Authorization: `Bearer ${token}`, "X-Devshell-Generation": String(generation),
        "X-Devshell-Instance": "reverse-test", "content-type": "application/json",
    };
}

function connectWorker(
    port: number,
    token: string,
    generation: number,
    protocol: "v1" | "v2" = "v2",
    failHandshake = false,
): {
    acks: string[];
    closed: Promise<{ code: number; reason: string }>;
    errors: string[];
    methods: string[];
    opened: Promise<void>;
    ready: Promise<void>;
    socket: WebSocket;
} {
    const ready = barrier();
    const methods: string[] = [];
    const errors: string[] = [];
    const acks: string[] = [];
    let frameSequence = 0n;
    const session = randomBytes(16);
    const socket = new WebSocket(
        `ws://127.0.0.1:${port}/base/reverse/v1/connect`,
        protocol === "v2" ? "devshell-worker-transport.v2" : "devshell-worker-transport.v1",
        {
            headers: {
                Authorization: `Bearer ${token}`,
                "X-Devshell-Generation": String(generation),
                "X-Devshell-Instance": "reverse-test",
            },
        },
    );
    const channel = new TestWorkerChannel(
        async (data) =>
            await new Promise<void>((resolve, reject) => {
                const frame = protocol === "v2"
                    ? (() => {
                        const header = Buffer.alloc(28);
                        header.write("DSR2", 0, "ascii");
                        session.copy(header, 4);
                        header.writeBigUInt64BE(++frameSequence, 20);
                        return Buffer.concat([header, Buffer.from(data)]);
                    })()
                    : data;
                socket.send(frame, { binary: true }, (error) =>
                    error == null ? resolve() : reject(error),
                );
            }),
        () => socket.close(1000, "worker closed"),
    );
    void serveWorkerEndpoint(channel, methods, failHandshake).catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
    });
    socket.on("message", (data, isBinary) => {
        if (!isBinary && protocol === "v2") {
            if (data.toString() === "DSR2:ready") {
                acks.push("ready");
                ready.resolve();
            } else {
                acks.push(data.toString());
            }
            return;
        }
        assert.equal(isBinary, true);
        channel.emit(
            Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
        );
    });
    socket.on("error", (error) => {
        errors.push(error.message);
        channel.finish(error);
    });
    socket.once("close", (code, reason) => {
        channel.finish(
            code === 1000
                ? undefined
                : new Error(`WebSocket closed: ${code} ${reason.toString()}`),
        );
    });
    return {
        acks,
        ready: ready.promise,
        closed: new Promise((resolve) =>
            socket.once("close", (code, reason) =>
                resolve({ code, reason: reason.toString() }),
            ),
        ),
        errors,
        methods,
        opened: new Promise((resolve, reject) => {
            socket.once("open", () => resolve());
            socket.once("error", reject);
        }),
        socket,
    };
}

class TestWorkerChannel implements Channel {
    readonly #dataListeners = new Set<(data: Uint8Array) => void>();
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #send: (data: Uint8Array) => Promise<void>;
    readonly #closeTransport: () => void;
    #closed = false;
    #writeTail: Promise<void> = Promise.resolve();

    constructor(
        send: (data: Uint8Array) => Promise<void>,
        closeTransport: () => void,
    ) {
        this.#send = send;
        this.#closeTransport = closeTransport;
    }

    get closed(): boolean {
        return this.#closed;
    }

    write(data: Uint8Array): Promise<void> {
        if (this.#closed)
            return Promise.reject(new Error("worker channel is closed"));
        const copy = Uint8Array.from(data);
        const write = this.#writeTail.then(() => this.#send(copy));
        this.#writeTail = write.catch(() => undefined);
        return write;
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
        this.#closeTransport();
        this.finish(error);
    }

    emit(data: Uint8Array): void {
        if (this.#closed) return;
        for (const listener of [...this.#dataListeners])
            listener(Uint8Array.from(data));
    }

    finish(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const listener of [...this.#closeListeners]) listener(error);
        this.#dataListeners.clear();
        this.#closeListeners.clear();
    }
}

async function serveWorkerEndpoint(
    channel: Channel,
    methods: string[],
    failHandshake = false,
): Promise<void> {
    const endpoint = new Endpoint({ host: "reverse-test-worker" });
    const core = new Rpc(endpoint.bind("core"), {
        "worker.ping": () => {
            methods.push("worker.ping");
            return responseFor("worker.ping");
        },
        "worker.handshake": () => {
            methods.push("worker.handshake");
            if (failHandshake) throw new Error("Round5 injected Worker handshake failure");
            return responseFor("worker.handshake");
        },
        "worker.stop": () => {
            methods.push("worker.stop");
            return responseFor("worker.stop");
        },
    });
    const tool = new Rpc(endpoint.bind("tool"), {
        "tools.list": () => {
            methods.push("tools.list");
            return responseFor("tools.list");
        },
    });
    const closed = new Promise<void>((resolve) =>
        channel.onClose(() => resolve()),
    );
    const detach = await endpoint.accept(channel);
    try {
        await closed;
    } finally {
        detach();
        core.close();
        tool.close();
        endpoint.close();
    }
}

function responseFor(method: string): JsonValue {
    switch (method) {
        case "worker.ping":
            return { pong: true };
        case "worker.handshake":
            return {
                capabilities: { cancel: true, streaming: false, tools: true },
                instance: "reverse-test",
                platform: { arch: "x64", os: "test" },
                protocolVersion: WORKER_PROTOCOL_VERSION,
                workerVersion: "test",
                workspace: "/workspace",
            };
        case "tools.list":
            return { tools: [] };
        case "worker.stop":
            return { stopping: true };
        default:
            throw new Error(`Unexpected worker method: ${method}`);
    }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = performance.now() + 2_000;
    while (!predicate()) {
        assert.ok(performance.now() < deadline, "reverse lifecycle boundary was not reached");
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}
