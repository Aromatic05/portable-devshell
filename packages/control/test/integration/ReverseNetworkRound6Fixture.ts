import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { request } from "node:http";
import type { TestContext } from "node:test";

import { Instance, ReverseConnections } from "@portable-devshell/core";
import { HttpHost } from "@portable-devshell/mcp/testing";
import { ChannelBase, Endpoint, Rpc, WORKER_PROTOCOL_VERSION, normalizeConfigInstanceDraft, type Channel } from "@portable-devshell/shared";
import WebSocket from "ws";

import { InstanceRegistry } from "../../src/instance/Registry.ts";
import { ReverseCredentials } from "../../src/instance/reverse/Credentials.ts";
import { ReverseCredentialStore } from "../../src/instance/reverse/credential/Store.ts";
import { ReverseIngress } from "../../src/server/reverse/Ingress.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

export function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

export async function until(predicate: () => boolean | Promise<boolean>, timeout = 3_000) {
    const deadline = performance.now() + timeout;
    while (!(await predicate())) {
        assert.ok(performance.now() < deadline, "Round6 lifecycle boundary timed out");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

export function headers(token: string, generation: number, name = "r6-alpha") {
    return { Authorization: `Bearer ${token}`, "X-Devshell-Generation": String(generation),
        "X-Devshell-Instance": name, "content-type": "application/json" };
}

export interface WorkerOptions {
    fragment?: boolean;
    duplicate?: boolean;
    firstSequence?: number;
    handshake?: () => Promise<void>;
    failHandshake?: boolean;
    session?: Buffer;
}

// Real admission and disk commits; only an explicitly requested commit pause is injected.
class ReverseNetworkRound6Store extends ReverseCredentialStore {
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

const streamCleanups = new WeakMap<TestContext, Array<() => Promise<void>>>();

export async function fixture(t: TestContext) {
    const home = await createTestTempDirectory("reverse-network-round6");
    // Instance.create resolves os.homedir() synchronously for its audit storage.
    // Scope all incidental Instance paths to this disposable fixture as well.
    const environment = { HOME: home, USERPROFILE: home, PORTABLE_DEVSHELL_HOME: `${home}/.devshell`, XDG_RUNTIME_DIR: home };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    Object.assign(process.env, environment);
    t.after(() => {
        for (const key of Object.keys(environment)) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    });
    const instances = ["r6-alpha", "r6-beta"].map((name) => Instance.create(normalizeConfigInstanceDraft({ enabled: true, name, provider: "reverse" })));
    const registry = new InstanceRegistry(instances);
    const store = new ReverseNetworkRound6Store(home);
    const connections = new ReverseConnections({ instances: registry });
    const publicBaseUrl = "http://127.0.0.1/base";
    const credentials = new ReverseCredentials({ credentialStore: store, instanceRegistry: registry, publicBaseUrl });
    credentials.setDisconnectHandler((name) => connections.disconnect(name));
    const host = new HttpHost({ listenHost: "127.0.0.1", listenPort: 0, publicBaseUrl });
    const ingress = new ReverseIngress({ connections, credentials, publicBaseUrl });
    const workers: ReturnType<typeof worker>[] = [];
    const cleanups: Array<() => Promise<void>> = [];
    streamCleanups.set(t, cleanups);
    t.after(async () => {
        store.release.resolve();
        for (const cleanup of cleanups) await cleanup();
        streamCleanups.delete(t);
        connections.stop();
        for (const w of workers) w.socket.terminate();
        await Promise.all(workers.map((w) => w.closed));
        await Promise.all(workers.map((w) => w.serving));
        ingress.stop();
        await host.stop();
        await Promise.all(instances.map((instance) => instance.close()));
        await rm(home, { recursive: true, force: true });
    });
    ingress.install(host);
    await host.start();
    assert.ok(host.address && typeof host.address === "object");
    const base = `http://127.0.0.1:${host.address.port}/base/reverse/v1`;
    const enroll = async (name = "r6-alpha") => {
        const code = await store.createDeviceCode(name);
        const response = await fetch(`${base}/enroll`, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceCode: code.deviceCode, arch: "x64", os: "test", workerVersion: "round6" }) });
        assert.equal(response.status, 200);
        return ((await response.json()) as { deviceToken: string }).deviceToken;
    };
    const connect = (token: string, generation: number, options: WorkerOptions = {}, name = "r6-alpha") => {
        const result = worker(base, token, generation, name, options);
        workers.push(result);
        return result;
    };
    return { home, store, credentials, connections, base, enroll, connect, alpha: instances[0]!, beta: instances[1]! };
}

export async function ping(instance: Instance) {
    const signal = AbortSignal.timeout(2_000);
    const rpc = new Rpc(await instance.supervision.endpoint.connect(`${instance.config.name}-worker`, "core", signal));
    try { return await rpc.request("worker.ping", undefined, signal); }
    finally { rpc.close(); }
}

function envelope(session: Buffer, sequence: number, payload: Uint8Array) {
    const header = Buffer.alloc(28);
    header.write("DSR2", 0, "ascii");
    session.copy(header, 4);
    header.writeBigUInt64BE(BigInt(sequence), 20);
    return Buffer.concat([header, payload]);
}

async function send(socket: WebSocket, data: Uint8Array, fragment = false) {
    const parts = fragment ? [data.subarray(0, 3), data.subarray(3, 25), data.subarray(25)] : [data];
    for (const [index, part] of parts.entries()) {
        await new Promise<void>((resolve, reject) => {
            const closed = () => { reject(new Error("Round6 socket closed during write")); };
            socket.once("close", closed);
            socket.send(part, { binary: true, fin: index === parts.length - 1 }, (error) => {
                socket.off("close", closed);
                if (error == null) resolve();
                else reject(error);
            });
        });
    }
}

function worker(base: string, token: string, generation: number, name: string, options: WorkerOptions) {
    const socket = new WebSocket(`${base.replace("http:", "ws:")}/connect`, "devshell-worker-transport.v2", { headers: headers(token, generation, name) });
    return workerSession(socket, name, options);
}

export function workerSession(socket: WebSocket, name: string, options: WorkerOptions = {}) {
    const ready = barrier();
    const methods: string[] = [];
    const errors: string[] = [];
    const acks: string[] = [];
    const session = options.session ?? randomBytes(16);
    let sequence = (options.firstSequence ?? 1) - 1;
    const frames: Buffer[] = [];
    const channel = new ReverseNetworkRound6Channel(async (data) => {
        const frame = envelope(session, ++sequence, data);
        frames.push(frame);
        await send(socket, frame, options.fragment);
        if (options.duplicate) await send(socket, frame, options.fragment);
    }, () => socket.close(1000, "worker closed"));
    const serving = serve(channel, methods, name, options).catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
    });
    socket.on("error", (error) => { errors.push(error.message); channel.finish(error); });
    socket.on("message", (data, binary) => {
        if (!binary) {
            acks.push(data.toString());
            if (data.toString() === "DSR2:ready") ready.resolve();
            return;
        }
        channel.emit(Buffer.from(data as Buffer));
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.once("close", (code, reason) => {
        channel.finish();
        resolve({ code, reason: reason.toString() });
    }));
    return { socket, ready: ready.promise, closed, serving, methods, errors, acks, frames,
        replay: async (index: number) => { await send(socket, frames[index]!); },
        // Invalid input deliberately causes immediate server termination; do not
        // require a successful local flush callback as an additional invariant.
        inject: (seq: number) => { socket.send(envelope(session, seq, new Uint8Array([0])), { binary: true }); },
    };
}

async function serve(channel: Channel, methods: string[], name: string, options: WorkerOptions = {}) {
    const endpoint = new Endpoint({ host: `${name}-worker` });
    const core = new Rpc(endpoint.bind("core"), {
        "worker.ping": () => { methods.push("worker.ping"); return { pong: true }; },
        "worker.handshake": async () => {
            methods.push("worker.handshake");
            await options.handshake?.();
            if (options.failHandshake) throw new Error("Round6 rejected worker handshake");
            return { capabilities: { cancel: true, streaming: false, tools: true }, instance: name,
                platform: { arch: "x64", os: "test" }, protocolVersion: WORKER_PROTOCOL_VERSION,
                workerVersion: "round6", workspace: "/workspace" };
        },
    });
    const tool = new Rpc(endpoint.bind("tool"), { "tools.list": () => { methods.push("tools.list"); return { tools: [] }; } });
    const closed = new Promise<void>((resolve) => channel.onClose(() => resolve()));
    try {
        const detach = await endpoint.accept(channel);
        try { await closed; } finally { detach(); }
    } finally { core.close(); tool.close(); endpoint.close(); }
}

export interface UpstreamFrame { seq: number; frame: string }

export async function post(base: string, token: string, generation: number, frames: UpstreamFrame[], name = "r6-alpha") {
    return await fetch(`${base}/frames`, { method: "POST", headers: headers(token, generation, name), body: JSON.stringify({ generation, frames }) });
}

// Chunked HTTP is real; writes deliberately split JSON tokens and base64 text.
export async function chunkedPost(base: string, token: string, generation: number, frames: UpstreamFrame[]) {
    const body = JSON.stringify({ generation, frames });
    return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const req = request(`${base}/frames`, { method: "POST", headers: headers(token, generation) }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (bytes: Buffer) => chunks.push(bytes));
            res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) as unknown }));
            res.on("error", reject);
        });
        req.on("error", reject);
        void (async () => {
            for (let offset = 0; offset < body.length; offset += 7) {
                req.write(body.slice(offset, offset + 7));
                await new Promise((done) => setImmediate(done));
            }
            req.end();
        })();
    });
}

export async function sse(t: TestContext, base: string, token: string, generation: number,
    upload?: (frames: UpstreamFrame[]) => Promise<void>, lastEventId = 0) {
    const response = await fetch(`${base}/events`, { headers: { ...headers(token, generation), "Last-Event-ID": String(lastEventId) } });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const methods: string[] = [];
    const ids: number[] = [];
    const errors: unknown[] = [];
    let sequence = 0;
    const channel = new ReverseNetworkRound6Channel(async (bytes) => {
        // Split FrameProtocol headers and payloads across independent upstream sequences.
        const cuts = [bytes.subarray(0, 1), bytes.subarray(1, 7), bytes.subarray(7)].filter((part) => part.length > 0);
        const frames = cuts.map((part) => ({ seq: ++sequence, frame: Buffer.from(part).toString("base64") }));
        if (upload) await upload(frames);
        else {
            const result = await chunkedPost(base, token, generation, frames);
            assert.equal(result.status, 200);
            assert.deepEqual(result.body, { acceptedThrough: sequence, generation });
        }
    }, () => undefined);
    const serving = serve(channel, methods, "r6-alpha").catch((error: unknown) => { errors.push(error); });
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
                const id = event.split("\n").find((line) => line.startsWith("id:"));
                const data = event.split("\n").find((line) => line.startsWith("data:"));
                if (data !== undefined) {
                    assert.ok(id);
                    ids.push(Number(id.slice(3).trim()));
                    channel.emit(Buffer.from(data.slice(5).trim(), "base64"));
                }
                boundary = buffered.indexOf("\n\n");
            }
        }
    })();
    const cleanups = streamCleanups.get(t);
    assert.ok(cleanups, "SSE worker must belong to an isolated Round6 fixture");
    cleanups.push(async () => { await reader.cancel(); channel.finish(); await pumping; await serving; });
    return { methods, ids, errors, pumping, sequence: () => sequence, cancel: () => reader.cancel() };
}

class ReverseNetworkRound6Channel extends ChannelBase {
    readonly #send: (data: Uint8Array) => Promise<void>;
    readonly #closeTransport: () => void;
    #writeTail: Promise<void> = Promise.resolve();

    constructor(send: (data: Uint8Array) => Promise<void>, closeTransport: () => void) {
        super();
        this.#send = send;
        this.#closeTransport = closeTransport;
    }

    write(data: Uint8Array): Promise<void> {
        if (this.closed) return Promise.reject(new Error("Round6 worker channel is closed"));
        const copy = Uint8Array.from(data);
        const operation = this.#writeTail.then(() => this.#send(copy));
        this.#writeTail = operation.catch(() => undefined);
        return operation;
    }

    close(error?: Error): void {
        if (this.closed) return;
        this.#closeTransport();
        this.finish(error);
    }

    emit(data: Uint8Array): void { this.emitData(data); }
    override finish(error?: Error): void { super.finish(error); }
}
