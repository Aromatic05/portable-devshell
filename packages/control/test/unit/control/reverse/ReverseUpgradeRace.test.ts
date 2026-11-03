import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import test, { type TestContext } from "node:test";

import { ReverseConnections, type Instance } from "@portable-devshell/core";
import {
    ChannelBase, Endpoint, Rpc, WORKER_PROTOCOL_VERSION, asInstanceName,
    type MessageStream, type ReverseWorkerConnectionState,
} from "@portable-devshell/shared";
import { WorkerAssetResolver } from "../../../../../core/src/instance/runtime/provision/Asset.ts";
import type { WorkerTarget } from "../../../../../core/src/instance/runtime/provision/Target.ts";
import { resolveWorkerInstanceConfig } from "../../../../../core/src/instance/runtime/provision/Config.ts";
import { WorkerInstanceConnection } from "../../../../../core/src/instance/runtime/supervision/Connection.ts";
import { InstanceStateMachine } from "../../../../../core/src/instance/runtime/supervision/State.ts";
import { WorkerTunnel } from "../../../../../core/src/instance/runtime/execution/capability/tunnel/Tunnel.ts";
import { TransportConnection } from "../../../../../core/src/instance/transport/endpoint/Connection.ts";
import { TransportFactory } from "../../../../../core/src/instance/transport/endpoint/Factory.ts";
import { WorkerProtocolClient } from "../../../../../core/src/instance/transport/packet/Client.ts";

function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

class MemoryChannel extends ChannelBase {
    peer!: MemoryChannel;
    async write(data: Uint8Array): Promise<void> {
        if (this.closed || this.peer.closed) throw new Error("Memory channel closed.");
        const copy = Uint8Array.from(data);
        queueMicrotask(() => { if (!this.peer.closed) this.peer.emitData(copy); });
    }
    close(error?: Error): void {
        if (this.closed) return;
        this.finish(error);
        this.peer.close(error);
    }
}

async function fixture(t: TestContext, reply: "staged" | "lost" | "transfer-failed" = "staged") {
    // Only the asset boundary and process tunnel are fake. No shell is run,
    // installed binary resolved, or release downloaded by these tests.
    const directory = await mkdtemp(join(tmpdir(), "reverse-upgrade-race-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bytes = Buffer.from("isolated test asset, never executed");
    const binaryPath = join(directory, "worker");
    await writeFile(binaryPath, bytes);
    const target = { version: "2.0.0", sha256: createHash("sha256").update(bytes).digest("hex") };
    const source = { version: "1.0.0", sha256: "a".repeat(64) };
    t.mock.method(WorkerAssetResolver.prototype, "publishedVersion", () => target.version);
    t.mock.method(WorkerAssetResolver.prototype, "resolvePublished", async (platform: WorkerTarget) => ({
        version: target.version,
        asset: { binaryPath, sha256: target.sha256, target: platform, source: "release", searchedPaths: [] },
    }));
    const warnings = t.mock.method(console, "warn", () => {});
    const name = asInstanceName("upgrade-race");
    const transport = new TransportConnection();
    let attachmentGate: (() => Promise<void>) | undefined;
    transport.onAttach(async () => { await attachmentGate?.(); });
    const endpoint = TransportFactory.createEndpoint(transport, "control", "worker");
    const protocol = new WorkerProtocolClient(endpoint, "worker");
    const state = new InstanceStateMachine(name);
    const eventGates = new Map<string, () => Promise<void>>();
    const events: string[] = [];
    const supervision = new WorkerInstanceConnection({
        config: resolveWorkerInstanceConfig({ name, managementMode: "selfManaged", transportConnection: transport }),
        endpoint, protocolClient: protocol, transportConnection: transport,
        tunnel: new WorkerTunnel(endpoint, "worker"),
        snapshot: () => state.snapshot(), metadataChanged() {},
        async appendEvent(type) {
            events.push(type);
            await eventGates.get(type)?.();
        },
        async applyStateUpdate(update, isCurrent = () => true) {
            return isCurrent() ? state.apply(update) : state.snapshot();
        },
    });
    const instance = {
        config: { name, provider: "reverse" },
        lifecycle: { acquireLease: () => ({ instance, release() {} }) },
        provision: { reverseConnection: transport },
    } as unknown as Instance;
    const connections = new ReverseConnections({ instances: { get: () => instance } });
    const order: string[] = [];
    const uploaded: Buffer[] = [];
    const tunnel = t.mock.method(WorkerTunnel.prototype, "execProcess", async () => ({
        async write(data: Uint8Array) {
            if (reply === "transfer-failed") throw new Error("injected transfer failure before EOF");
            uploaded.push(Buffer.from(data));
        },
        async finish() { order.push("EOF"); },
        async read() {
            if (reply === "lost") throw new Error("injected staged reply loss after EOF");
            return order.includes("reply") ? undefined : (order.push("reply"), Buffer.from("staged\n"));
        },
        async close() {}, async cancel() {},
    }) as unknown as MessageStream);
    const workers: Endpoint[] = [];
    t.after(async () => {
        connections.stop();
        await supervision.close();
        endpoint.close();
        for (const worker of workers) worker.close();
    });
    function worker(generation: number, build = target, handshakeGate?: ReturnType<typeof barrier>) {
        const control = new MemoryChannel();
        const remote = new MemoryChannel();
        control.peer = remote;
        remote.peer = control;
        const peer = new Endpoint({ host: "worker" });
        workers.push(peer);
        const entered = barrier();
        const states: ReverseWorkerConnectionState[] = [];
        let pingGate: (() => Promise<void>) | undefined;
        const rpc = new Rpc(peer.bind("core"), {
            "worker.ping": async () => { await pingGate?.(); return { pong: true }; },
            "worker.handshake": async () => {
                entered.resolve();
                await handshakeGate?.promise;
                return {
                    capabilities: { cancel: true, streaming: false, tools: true },
                    instance: name, platform: { arch: "x64", os: "linux" },
                    protocolVersion: WORKER_PROTOCOL_VERSION, workspace: "/workspace",
                    workerVersion: build.version, workerSha256: build.sha256,
                };
            },
        });
        t.after(() => { handshakeGate?.resolve(); rpc.close(); });
        const accepted = peer.accept(remote);
        // Observe acceptance rejection immediately so teardown cannot produce
        // an unhandled rejection when a deliberate failure closes the channel.
        void accepted.catch(() => {});
        const activate = () => connections.activate({ descriptor: instance, generation }, "wss", control, {
            signalState(value) { states.push(value); order.push(value.state); },
        });
        return { control, entered, states, activate, accepted,
            pausePing(callback: () => Promise<void>) { pingGate = callback; } };
    }
    return {
        source, target, worker, state, endpoint, supervision, protocol, order, warnings, tunnel, events,
        uploaded: () => Buffer.concat(uploaded),
        pauseEvent(type: string, callback: () => Promise<void>) { eventGates.set(type, callback); },
        pauseAttachment(callback: () => Promise<void>) { attachmentGate = callback; },
    };
}

test("reverse upgrade announces upgrading before EOF and never refreshes the staged source to Ready", async (t) => {
    const f = await fixture(t);
    const source = f.worker(1, f.source);
    assert.equal(await source.activate(), false);
    assert.deepEqual(f.order, ["upgrading", "EOF", "reply"]);
    assert.equal(f.uploaded().toString(), "isolated test asset, never executed");
    await f.supervision.refreshRunningStatus();
    assert.equal(f.state.snapshot().ready, false);
    assert.deepEqual(source.states, [{ state: "upgrading" }]);
    const wrong = f.worker(2, { ...f.target, sha256: "b".repeat(64) });
    await assert.rejects(wrong.activate(), /version and SHA256/u);
    assert.equal(source.control.closed, false);
    assert.equal(f.state.snapshot().ready, false);
    const target = f.worker(3);
    assert.equal(await target.activate(), true);
    assert.equal(f.state.snapshot().ready, true);
    assert.equal(source.control.closed, true);
});

test("reverse lost staged acknowledgement keeps the exact target required until replacement handshakes", async (t) => {
    const f = await fixture(t, "lost");
    const source = f.worker(1, f.source);
    await assert.rejects(source.activate(), /staged reply loss/u);
    assert.deepEqual(f.order, ["upgrading", "EOF", "failed"]);
    assert.equal(f.state.snapshot().ready, false);
    const old = f.worker(2, f.source);
    await assert.rejects(old.activate(), /version and SHA256/u);
    const wrong = f.worker(3, { ...f.target, sha256: "b".repeat(64) });
    await assert.rejects(wrong.activate(), /version and SHA256/u);
    const target = f.worker(4);
    assert.equal(await target.activate(), true);
    assert.equal(f.state.snapshot().ready, true);
});

test("reverse failure before EOF permits a protocol-compatible source without staging a restart", async (t) => {
    const f = await fixture(t, "transfer-failed");
    const source = f.worker(1, f.source);
    assert.equal(await source.activate(), true);
    assert.deepEqual(f.order, []);
    assert.equal(f.state.snapshot().ready, true);
});

test("reverse upgrade timeout preserves a verifying candidate while closing only source gateway A", async (t) => {
    const f = await fixture(t);
    const source = f.worker(1, f.source);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(await source.activate(), false);
    // Begin B just before the upgrade deadline, within its separate 20s
    // admission budget. Only the 120s upgrade timer should fire below.
    t.mock.timers.tick(119_000);
    const oldIdentity = f.endpoint.connectionIdentity;
    const gate = barrier();
    const target = f.worker(2, f.target, gate);
    const activation = target.activate();
    await target.entered.promise;
    assert.equal(f.endpoint.connectionIdentity, oldIdentity);
    t.mock.timers.tick(1_000);
    await turn();
    assert.equal(f.state.snapshot().ready, false);
    assert.equal(f.state.snapshot().connectionState, "failed");
    assert.equal(source.control.closed, true);
    assert.equal(target.control.closed, false);
    gate.resolve();
    assert.equal(await activation, true);
    assert.equal(f.state.snapshot().ready, true);
    assert.deepEqual(await f.protocol.ping(), { pong: true });
});

test("reverse upgrade timeout lets the exact source recover in a newer generation without accepting a wrong SHA", async (t) => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const source = f.worker(5, f.source);
    assert.equal(await source.activate(), false);
    t.mock.timers.tick(120_000);
    await turn();
    await f.supervision.refreshRunningStatus();
    assert.equal(f.state.snapshot().ready, false);
    const wrong = f.worker(6, { ...f.source, sha256: "c".repeat(64) });
    await assert.rejects(wrong.activate(), /version and SHA256/u);
    assert.equal(f.state.snapshot().ready, false);
    const recovered = f.worker(7, f.source);
    assert.equal(await recovered.activate(), true);
    assert.equal(f.state.snapshot().ready, true);
    assert.equal(f.tunnel.mock.callCount(), 1, "source recovery must not stage an endless upgrade loop");
});

test("reverse upgrade timeout during target finalization does not strand the verified replacement", async (t) => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const source = f.worker(1, f.source);
    assert.equal(await source.activate(), false);
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    f.pauseEvent("reverse.connected", async () => { entered.resolve(); await release.promise; });
    const target = f.worker(2);
    const activation = target.activate();
    await entered.promise;
    assert.equal(source.control.closed, true);
    const targetIdentity = f.endpoint.connectionIdentity;
    t.mock.timers.tick(120_000);
    await turn();
    assert.equal(target.control.closed, false);
    assert.equal(f.state.snapshot().ready, false);
    release.resolve();
    assert.equal(await activation, true);
    assert.equal(f.state.snapshot().ready, true);
    assert.equal(f.endpoint.connectionIdentity, targetIdentity);
});

test("reverse upgrade timeout cannot close B attached before Endpoint consumes its channel", async (t) => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const source = f.worker(1, f.source);
    assert.equal(await source.activate(), false);
    t.mock.timers.tick(119_000);
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    // Pause the real TransportConnection attachment notification before the
    // supervision listener takes B; #attached is B and the gateway is still A.
    f.pauseAttachment(async () => { entered.resolve(); await release.promise; });
    const target = f.worker(2);
    const activation = target.activate();
    await entered.promise;
    t.mock.timers.tick(1_000);
    await turn();
    assert.equal(source.control.closed, true);
    assert.equal(target.control.closed, false);
    assert.equal(f.state.snapshot().ready, false);
    release.resolve();
    assert.equal(await activation, true);
    assert.equal(f.state.snapshot().ready, true);
});

test("reverse failed refresh RPC from gateway A cannot close its replacement B", async (t) => {
    const f = await fixture(t);
    const source = f.worker(1);
    assert.equal(await source.activate(), true);
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    source.pausePing(async () => { entered.resolve(); await release.promise; throw new Error("stale A ping failed"); });
    const refresh = f.supervision.refreshRunningStatus();
    await entered.promise;
    const target = f.worker(2);
    assert.equal(await target.activate(), true);
    release.resolve();
    await refresh;
    assert.equal(source.control.closed, true);
    assert.equal(target.control.closed, false);
    assert.equal(f.state.snapshot().ready, true);
    assert.equal(f.supervision.snapshotReverse()?.generation, 2);
    assert.deepEqual(await f.protocol.ping(), { pong: true });
});

test("reverse delayed disconnect state from A cannot overwrite B readiness", async (t) => {
    const f = await fixture(t);
    const source = f.worker(1);
    assert.equal(await source.activate(), true);
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    f.pauseEvent("worker.transportDisconnected", async () => { entered.resolve(); await release.promise; });
    source.control.close(new Error("injected A physical disconnect"));
    await entered.promise;
    const target = f.worker(2);
    assert.equal(await target.activate(), true);
    release.resolve();
    await turn();
    assert.equal(target.control.closed, false);
    assert.equal(f.state.snapshot().ready, true);
    assert.equal(f.supervision.snapshotReverse()?.generation, 2);
    assert.deepEqual(await f.protocol.ping(), { pong: true });
});
