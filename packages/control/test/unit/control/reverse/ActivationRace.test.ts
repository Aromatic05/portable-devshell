import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ReverseConnections, type Instance } from "@portable-devshell/core";
import {
    ChannelBase, Endpoint, Rpc, ReverseSseChannel, WebServerChannel,
    WORKER_PROTOCOL_VERSION, asInstanceName, type Channel,
} from "@portable-devshell/shared";
import { ReverseCredentials } from "../../../../src/instance/reverse/Credentials.ts";
import { ReverseCredentialStore } from "../../../../src/instance/reverse/credential/Store.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

for (const transport of ["wss", "sse"] as const) {
    for (const mutation of ["revoke", "rotate"] as const) {
        test(`${transport} activation cannot finish RPC after same-instance credential ${mutation}`, { timeout: 10_000 }, async (t) => {
            const home = await createTestTempDirectory("reverse-activation-race");
            let attached!: Channel;
            const controller = new Endpoint({ connectChannel: async () => attached });
            let probeCalls = 0;
            const controlProbe = new Rpc(controller.bind("probe"), {
                probe: () => { probeCalls += 1; return { ok: true }; },
            });
            // The descriptor exposes only the lifecycle/attachment contract used
            // by ReverseConnections; the candidate carries real Endpoint RPC.
            const instance: Instance = {
                config: { name: asInstanceName("reverse-race"), provider: "reverse" },
                lifecycle: { acquireLease: () => ({ instance, release() {} }) },
                provision: { reverseConnection: {
                    async attach(channel: Channel, input: { signal: AbortSignal }) {
                        attached = channel;
                        await controller.reconnect({
                            signal: input.signal,
                            verify: async (connect) => {
                                const rpc = new Rpc(connect("race-worker", "core"));
                                try {
                                    await rpc.request("worker.ping", undefined, input.signal);
                                    await rpc.request("worker.handshake", undefined, input.signal);
                                } finally { rpc.close(); }
                            },
                        });
                    },
                } },
            } as unknown as Instance;
            const registry = { get: () => instance };
            const connections = new ReverseConnections({ instances: registry });
            const credentials = new ReverseCredentials({
                credentialStore: new ReverseCredentialStore(home),
                instanceRegistry: registry,
                publicBaseUrl: "https://controller.example.test",
            });
            credentials.setDisconnectHandler((name) => connections.disconnect(name));
            const identity = { descriptor: instance, generation: 1 };
            let upstreamSeq = 0;
            const channel = await transportChannel(transport, (data) => {
                connections.acceptUpstream(identity, {
                    generation: 1,
                    frames: [{ seq: ++upstreamSeq, frame: Buffer.from(data).toString("base64") }],
                });
            });
            const entered = deferred();
            const release = deferred();
            const methods: string[] = [];
            const endpoint = new Endpoint({ host: "race-worker" });
            const core = new Rpc(endpoint.bind("core"), {
                "worker.ping": async () => {
                    methods.push("worker.ping");
                    entered.resolve();
                    await release.promise;
                    return { pong: true };
                },
                "worker.handshake": () => {
                    methods.push("worker.handshake");
                    return {
                        capabilities: { cancel: true, streaming: false, tools: true },
                        instance: "reverse-race",
                        platform: { arch: "x64", os: "test" },
                        protocolVersion: WORKER_PROTOCOL_VERSION,
                        workerVersion: "test", workspace: "/workspace",
                    };
                },
            });
            const workerProbe = new Rpc(endpoint.bind("probe").connect(controller.host, "probe"));
            t.after(async () => {
                release.resolve();
                connections.stop();
                core.close();
                workerProbe.close();
                controlProbe.close();
                endpoint.close();
                controller.close();
                await channel.dispose();
            });
            const accepted = endpoint.accept(channel.worker);
            const code = await credentials.createDeviceCode(instance.config.name);
            const { deviceToken } = await credentials.consumeDeviceCode(code.deviceCode);
            const activation = credentials.runAuthenticated(instance.config.name, deviceToken,
                async () => connections.activate(identity, transport, channel.control));
            const rejected = assert.rejects(activation, /disconnected|closed|aborted/iu);
            await entered.promise;
            await accepted;
            assert.equal(channel.control.closed, false);
            assert.equal(channel.worker.closed, false);
            assert.deepEqual(await workerProbe.request("probe"), { ok: true });
            assert.equal(probeCalls, 1);
            await credentials[mutation === "revoke" ? "revokeDeviceToken" : "rotateDeviceToken"](instance.config.name);
            release.resolve();
            await rejected;
            await channel.closed;
            assert.equal(channel.control.closed, true);
            assert.equal(controller.connected, false);
            await assert.rejects(credentials.authenticate(instance.config.name, deviceToken), {
                code: "reverse.deviceTokenInvalid",
            });
            // A previously working Worker RPC cannot reach Control after closure,
            // and the delayed ping reply cannot continue candidate verification.
            await assert.rejects(workerProbe.request("probe"));
            assert.equal(probeCalls, 1);
            assert.deepEqual(methods, ["worker.ping"]);
        });
    }
}

class WorkerChannel extends ChannelBase {
    constructor(readonly send: (data: Uint8Array) => Promise<void>, readonly disconnect: () => void) { super(); }
    receive(data: Uint8Array): void { this.emitData(data); }
    async write(data: Uint8Array): Promise<void> {
        if (this.closed) throw new Error("Worker channel is closed.");
        await this.send(data);
    }
    close(): void {
        if (this.closed) return;
        this.finish();
        this.disconnect();
    }
}

async function transportChannel(
    transport: "wss" | "sse",
    upstream: (data: Uint8Array) => void,
): Promise<{ control: Channel; worker: WorkerChannel; closed: Promise<unknown>; dispose(): Promise<void> }> {
    if (transport === "sse") {
        const closed = deferred();
        const response = Object.assign(new EventEmitter(), {
            writableEnded: false,
            write(value: string) {
                const frame = /^data: (.+)$/mu.exec(value);
                assert.ok(frame);
                worker.receive(Buffer.from(frame[1]!, "base64"));
                return true;
            },
            end() { this.writableEnded = true; worker.close(); closed.resolve(); },
        });
        const control = new ReverseSseChannel(response as never, 0, { heartbeatIntervalMs: 60_000 });
        const worker = new WorkerChannel(async (data) => upstream(data), () => control.close());
        return { control, worker, closed: closed.promise, async dispose() { control.close(); } };
    }
    const closed = deferred();
    // Model only the WebSocket boundary; framing, Endpoint and RPC are real.
    const socket = Object.assign(new EventEmitter(), {
        readyState: 1,
        send(data: Uint8Array, _options: { binary: true }, callback: (error?: Error) => void) {
            worker.receive(data);
            callback();
        },
        close() {
            this.readyState = 3;
            worker.close();
            socket.emit("close", 1000, Buffer.alloc(0));
            closed.resolve();
        },
        ping() {},
        terminate() { this.close(); },
    });
    const control = new WebServerChannel(socket);
    const worker = new WorkerChannel(async (data) => {
        socket.emit("message", Buffer.from(data), true);
    }, () => control.close());
    return { control, worker, closed: closed.promise, async dispose() { control.close(); } };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}
