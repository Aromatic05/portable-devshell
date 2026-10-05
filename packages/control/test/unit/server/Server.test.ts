import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createDefaultControlConfig, normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import type { ControlRuntimeState } from "../../../src/server/runtime/State.ts";
import test from "node:test";

import { ControlServer } from "../../../src/server/Server.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

test("concurrent restart then shutdown preserves lifecycle request order", async (t) => {
    const xdgRuntimeDir = await createTestTempDirectory("control-server");
    t.after(async () => {
        await rm(xdgRuntimeDir, { force: true, recursive: true });
    });
    const events: string[] = [];
    let releaseFirstStop!: () => void;
    const firstStopGate = new Promise<void>((resolve) => {
        releaseFirstStop = resolve;
    });
    let controls:
        { restart(): Promise<void>; shutdown(): Promise<void> } | undefined;
    let runtimeNumber = 0;
    const server = new ControlServer({
        configStore: {
            async readOrCreate() {
                return createDefaultControlConfig();
            },
        } as never,
        runtimeFactory: {
            async create(options: {
                restart(): Promise<void>;
                shutdown(): Promise<void>;
            }) {
                controls ??= options;
                runtimeNumber += 1;
                const current = runtimeNumber;
                return {
                    async start() {
                        events.push(`start-${current}`);
                    },
                    async stop() {
                        events.push(`stop-${current}`);
                        if (current === 1) {
                            await firstStopGate;
                        }
                    },
                };
            },
        } as never,
        xdgRuntimeDir,
    });

    await server.start();
    const restarting = controls!.restart();
    await waitFor(() => events.includes("stop-1"));
    const shuttingDown = controls!.shutdown();
    releaseFirstStop();

    await Promise.all([restarting, shuttingDown]);

    assert.deepEqual(events, ["start-1", "stop-1", "start-2", "stop-2"]);
});

test("failed stop preserves the runtime owner until a retry succeeds", async (t) => {
    const xdgRuntimeDir = await createTestTempDirectory("control-server-stop");
    t.after(async () => {
        await rm(xdgRuntimeDir, { force: true, recursive: true });
    });
    let stopCalls = 0;
    let creates = 0;
    const stopFailure = new Error("stop failed");
    const server = new ControlServer({
        configStore: {
            async readOrCreate() {
                return createDefaultControlConfig();
            },
        } as never,
        runtimeFactory: {
            async create() {
                creates += 1;
                return {
                    async start() {},
                    async stop() {
                        stopCalls += 1;
                        if (stopCalls === 1) throw stopFailure;
                    },
                };
            },
        } as never,
        xdgRuntimeDir,
    });

    await server.start();
    await assert.rejects(
        server.stop(),
        (error: unknown) => error === stopFailure,
    );
    assert.notEqual(server.config, undefined);
    await server.start();
    assert.equal(creates, 1);

    await server.stop();
    assert.equal(server.config, undefined);
    assert.equal(stopCalls, 2);
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for condition.");
}

test("runtime composition failure closes loaded instance domains before retry", async (t) => {
    const root = await createTestTempDirectory("control-server-compose");
    t.after(() => rm(root, { force: true, recursive: true }));
    const config = createDefaultControlConfig();
    config.instances = [normalizeConfigInstanceDraft({ name: "local", provider: "local" })];
    const failure = new Error("composition failed");
    const generations: import("@portable-devshell/core/instance").Instance[] = [];
    const runtimes: import("../../../src/server/runtime/Instance.ts").InstanceRuntime[] = [];
    const server = new ControlServer({
        configStore: { async readOrCreate() { return config; } } as never,
        homeDirectory: root,
        runtimeFactory: {
            async create({ state }: { state: ControlRuntimeState }) {
                const instance = state.instances.get("local")!;
                generations.push(instance);
                runtimes.push(state.instanceRuntimes.get(instance));
                throw failure;
            },
        } as never,
        xdgRuntimeDir: root,
    });

    await assert.rejects(server.start(), error => error === failure);
    assert.equal(server.config, undefined);
    assert.equal(generations[0]!.retired, true);
    assert.throws(() => runtimes[0]!.audit.api.events.readHighWater(), /closed/iu);
    await assert.rejects(server.start(), error => error === failure);
    assert.notEqual(generations[1], generations[0]);
    assert.equal(generations[1]!.retired, true);
});

test("failed startup cleanup retains its instance owner for explicit stop retry", async (t) => {
    const root = await createTestTempDirectory("control-server-cleanup-retry");
    t.after(() => rm(root, { force: true, recursive: true }));
    const config = createDefaultControlConfig();
    config.instances = [normalizeConfigInstanceDraft({ name: "retry-local", provider: "local" })];
    const failure = new Error("composition failed");
    const cleanupFailure = new Error("worker close failed");
    let restoreWorkerClose!: () => void;
    const server = new ControlServer({
        configStore: { async readOrCreate() { return config; } } as never,
        homeDirectory: root,
        runtimeFactory: {
            async create({ state }: { state: ControlRuntimeState }) {
                const worker = state.instances.get("retry-local")!.worker;
                const close = worker.close.bind(worker);
                restoreWorkerClose = () => { worker.close = close; };
                worker.close = async () => { throw cleanupFailure; };
                throw failure;
            },
        } as never,
        xdgRuntimeDir: root,
    });
    await assert.rejects(server.start(), error => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], failure);
        assert.ok(error.errors[1] instanceof AggregateError);
        return true;
    });
    assert.notEqual(server.config, undefined);
    restoreWorkerClose();
    await server.stop();
    assert.equal(server.config, undefined);
});
