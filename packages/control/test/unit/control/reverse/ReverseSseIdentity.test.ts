import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";

import { ReverseConnections, type Instance } from "@portable-devshell/core";
import { ChannelBase, Endpoint, Rpc, asInstanceName, type Channel } from "@portable-devshell/shared";

import { ReverseCredentials } from "../../../../src/instance/reverse/Credentials.ts";
import type { ReverseCredentialStore } from "../../../../src/instance/reverse/credential/Store.ts";
import type { ReverseHttpHost } from "../../../../src/server/reverse/Api.ts";
import { ReverseIngress } from "../../../../src/server/reverse/Ingress.ts";

function barrier<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

class Response extends EventEmitter {
    headersSent = false;
    writableEnded = false;
    statusCode = 0;
    body = "";
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; }
    flushHeaders() { this.headersSent = true; }
    write(value: string) { this.emit("write", value); return true; }
    end(value = "") {
        this.body += value;
        this.writableEnded = true;
        this.emit("close");
    }
}

class WorkerChannel extends ChannelBase {
    constructor(readonly send: (data: Uint8Array) => Promise<void>) { super(); }
    receive(data: Uint8Array) { this.emitData(data); }
    async write(data: Uint8Array) { await this.send(data); }
    close() { this.finish(); }
}

function fixture(t: TestContext) {
    let attached!: Channel;
    const controller = new Endpoint({ host: "identity-control", connectChannel: async () => attached });
    const instance = {
        config: { name: asInstanceName("identity-worker"), provider: "reverse" },
        lifecycle: { acquireLease: () => ({ instance, release() {} }) },
        provision: { reverseConnection: {
            async attach(channel: Channel, input: { signal: AbortSignal }) {
                attached = channel;
                await controller.reconnect({
                    preserveExisting: true,
                    signal: input.signal,
                    verify: async (connect) => {
                        const rpc = new Rpc(connect("identity-worker", "core"));
                        try {
                            assert.deepEqual(await rpc.request("worker.ping", undefined, input.signal), { pong: true });
                            await rpc.request("worker.handshake", undefined, input.signal);
                        } finally { rpc.close(); }
                    },
                });
            },
        } },
    } as unknown as Instance;
    const instances = { get: () => instance };
    const connections = new ReverseConnections({ instances });
    // Only credential persistence and HTTP I/O are substituted. Authentication,
    // Ingress, ReverseConnections, SSE, FrameProtocol, Endpoint and RPC are real.
    const credentials = new ReverseCredentials({
        instanceRegistry: instances,
        publicBaseUrl: "http://controller.test",
        credentialStore: {
            async authenticate() { return true; },
            async withAuthenticatedToken(_name: string, token: string, operation: (replacement: boolean) => Promise<void>) {
                await operation(token === "replacement");
                return true;
            },
        } as unknown as ReverseCredentialStore,
    });
    const ingress = new ReverseIngress({ connections, credentials, publicBaseUrl: "http://controller.test" });
    type Handler = Parameters<ReverseHttpHost["registerRawRoute"]>[2];
    const routes = new Map<string, Handler>();
    ingress.install({
        registerRawRoute(method, path, handler) {
            routes.set(`${method} ${path}`, handler);
            return () => routes.delete(`${method} ${path}`);
        },
        registerUpgradeHandler() { return () => undefined; },
    });
    const workers: Array<{ endpoint: Endpoint; core: Rpc; channel: WorkerChannel; accepted: Promise<unknown>; activation: Promise<void> }> = [];
    t.after(async () => {
        connections.stop();
        controller.close();
        for (const worker of workers) {
            worker.channel.close();
            worker.core.close();
            worker.endpoint.close();
            await worker.accepted;
            await worker.activation;
        }
        ingress.stop();
    });
    const request = (token: string, body?: unknown) => Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
        headers: { authorization: `Bearer ${token}`, "x-devshell-instance": "identity-worker", "x-devshell-generation": "1" },
    }) as unknown as IncomingMessage;
    const upstream = routes.get("post /reverse/v1/frames")!;
    const events = routes.get("get /reverse/v1/events")!;
    const post = async (token: string, frames: { seq: number; frame: string }[] = []) => {
        const response = new Response();
        await upstream(request(token, { generation: 1, frames }), response as unknown as ServerResponse);
        return { status: response.statusCode, body: JSON.parse(response.body) as unknown };
    };
    const connect = (token: string, handshake: () => Promise<void> = async () => {}) => {
        let sequence = 0;
        const frames: Array<{ seq: number; frame: string }> = [];
        const firstUpload = barrier<Awaited<ReturnType<typeof post>>>();
        const endpoint = new Endpoint({ host: "identity-worker" });
        const methods: string[] = [];
        const core = new Rpc(endpoint.bind("core"), {
            "worker.ping": () => { methods.push("worker.ping"); return { pong: true }; },
            "worker.handshake": async () => { methods.push("worker.handshake"); await handshake(); return { ok: true }; },
        });
        const channel = new WorkerChannel(async (bytes) => {
            const frame = { seq: ++sequence, frame: Buffer.from(bytes).toString("base64") };
            frames.push(frame);
            const reply = await post(token, [frame]);
            firstUpload.resolve(reply);
            assert.deepEqual(reply, { status: 200, body: { acceptedThrough: frame.seq, generation: 1 } });
        });
        const accepted = endpoint.accept(channel);
        const response = new Response();
        response.on("write", (value: string) => {
            const data = /^data: (.+)$/mu.exec(value);
            assert.ok(data);
            channel.receive(Buffer.from(data[1]!, "base64"));
        });
        response.on("close", () => channel.close());
        const activation = Promise.resolve(events(request(token), response as unknown as ServerResponse));
        workers.push({ endpoint, core, channel, accepted, activation });
        return { response, activation, accepted, firstUpload: firstUpload.promise, methods, frames, sequence: () => sequence };
    };
    const ping = async () => {
        const signal = AbortSignal.timeout(1_000);
        const rpc = new Rpc(await controller.connect("identity-worker", "core", signal));
        try { return await rpc.request("worker.ping", undefined, signal); }
        finally { rpc.close(); }
    };
    return { connect, post, ping };
}

for (const outcome of ["promote", "reject"] as const) {
    test(`equal-generation authenticated SSE replacement ${outcome} isolates real handshake and predecessor RPC`, { timeout: 5_000 }, async (t) => {
        const entered = barrier();
        const release = barrier();
        t.after(() => release.resolve());
        const f = fixture(t);
        const first = f.connect("previous");
        await first.activation;
        await first.accepted;
        assert.deepEqual(await f.ping(), { pong: true });
        const predecessorSequence = first.sequence();
        const candidate = f.connect("replacement", async () => {
            entered.resolve();
            await release.promise;
            if (outcome === "reject") throw new Error("injected candidate handshake rejection");
        });
        // Before awaiting the RPC barrier, assert the first actual FrameProtocol
        // reply was ACKed by its own channel, rather than as an old duplicate.
        assert.deepEqual(await candidate.firstUpload, { status: 200, body: { acceptedThrough: 1, generation: 1 } });
        await entered.promise;
        assert.deepEqual(await f.post("previous"), { status: 200, body: { acceptedThrough: predecessorSequence, generation: 1 } });
        assert.deepEqual(await f.ping(), { pong: true });
        assert.deepEqual(await f.ping(), { pong: true });
        const candidateSequence = candidate.sequence();
        const gap = await f.post("replacement", [{ seq: candidateSequence + 2, frame: Buffer.from([0]).toString("base64") }]);
        assert.equal(gap.status, 400);
        assert.deepEqual(await f.post("replacement", [candidate.frames.at(-1)!]), {
            status: 200, body: { acceptedThrough: candidateSequence, generation: 1 },
        });
        assert.equal((await f.post("unattached")).status, 409);
        assert.deepEqual(await f.ping(), { pong: true });
        assert.equal(first.response.writableEnded, false);
        assert.equal(candidate.response.writableEnded, false);
        assert.deepEqual(candidate.methods, ["worker.ping", "worker.handshake"]);
        release.resolve();
        await candidate.activation;
        await candidate.accepted;
        assert.deepEqual(await f.ping(), { pong: true });
        assert.equal(first.response.writableEnded, outcome === "promote");
        assert.equal(candidate.response.writableEnded, outcome === "reject");
        const retiredToken = outcome === "promote" ? "previous" : "replacement";
        assert.equal((await f.post(retiredToken, [{ seq: 999, frame: Buffer.from([0]).toString("base64") }])).status, 409);
        assert.deepEqual(await f.ping(), { pong: true });
    });
}
