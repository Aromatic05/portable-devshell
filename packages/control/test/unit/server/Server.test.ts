import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import {
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
} from "@portable-devshell/shared";

import { ControlServer } from "../../../src/server/Server.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

test("ControlServer interleaves domain and server lifecycle phases in dependency order", async (t) => {
    const xdgRuntimeDir = await createTestTempDirectory("control-server-phases");
    t.after(async () => {
        await rm(xdgRuntimeDir, { force: true, recursive: true });
    });
    const events: string[] = [];
    const server = new ControlServer({
        configStore: {
            async readOrCreate() {
                return createDefaultControlConfig();
            },
        } as never,
        runtimeFactory: {
            async create() {
                return {
                    state: {
                        async initialize() {
                            events.push("state.initialize");
                        },
                        async start() {
                            events.push("state.start");
                        },
                        async reconcile() {
                            events.push("state.reconcile");
                        },
                        async close() {},
                    },
                    server: {
                        async prepare() {
                            events.push("server.prepare");
                        },
                        async startTransport() {
                            events.push("server.transport");
                        },
                        async startHosts() {
                            events.push("server.hosts");
                        },
                        async stop() {},
                    },
                };
            },
        } as never,
        xdgRuntimeDir,
    });

    await server.start();
    assert.deepEqual(events, [
        "state.initialize",
        "server.prepare",
        "server.transport",
        "state.start",
        "server.hosts",
        "state.reconcile",
    ]);
    await server.stop();
});

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
        | { restart(): Promise<void>; shutdown(): Promise<void> }
        | undefined;
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
                    state: testState(),
                    server: {
                        async prepare() {},
                        async startTransport() {},
                        async startHosts() {
                            events.push(`start-${current}`);
                        },
                        async stop() {
                            events.push(`stop-${current}`);
                            if (current === 1) await firstStopGate;
                        },
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

test("failed stop preserves composed owners until a retry succeeds", async (t) => {
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
                    state: testState(),
                    server: {
                        async prepare() {},
                        async startTransport() {},
                        async startHosts() {},
                        async stop() {
                            stopCalls += 1;
                            if (stopCalls === 1) throw stopFailure;
                        },
                    },
                };
            },
        } as never,
        xdgRuntimeDir,
    });

    await server.start();
    await assert.rejects(server.stop(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], stopFailure);
        return true;
    });
    assert.notEqual(server.config, undefined);
    await server.start();
    assert.equal(creates, 1);

    await server.stop();
    assert.equal(server.config, undefined);
    assert.equal(stopCalls, 2);
});

test("composition failure closes loaded instances before retry", async (t) => {
    const root = await createTestTempDirectory("control-server-compose");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const config = createDefaultControlConfig();
    config.instances = [
        normalizeConfigInstanceDraft({ name: "local", provider: "local" }),
    ];
    const failure = new Error("composition failed");
    const generations: import("@portable-devshell/core/instance").Instance[] = [];
    const server = new ControlServer({
        configStore: { async readOrCreate() { return config; } } as never,
        homeDirectory: root,
        runtimeFactory: {
            async create({ instances }: Parameters<
                import("../../../src/server/runtime/Factory.ts").ControlRuntimeFactory["create"]
            >[0]) {
                generations.push(instances.registry.get("local")!);
                throw failure;
            },
        } as never,
        xdgRuntimeDir: root,
    });

    await assert.rejects(server.start(), (error) => error === failure);
    assert.equal(server.config, undefined);
    assert.equal(generations[0]!.lifecycle.closed, true);
    await assert.rejects(server.start(), (error) => error === failure);
    assert.notEqual(generations[1], generations[0]);
    assert.equal(generations[1]!.lifecycle.closed, true);
});

test("failed startup cleanup retains instance owner for explicit stop retry", async (t) => {
    const root = await createTestTempDirectory("control-server-cleanup-retry");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const config = createDefaultControlConfig();
    config.instances = [
        normalizeConfigInstanceDraft({ name: "retry-local", provider: "local" }),
    ];
    const failure = new Error("composition failed");
    const cleanupFailure = new Error("instance close failed");
    let restoreInstanceClose!: () => void;
    const server = new ControlServer({
        configStore: { async readOrCreate() { return config; } } as never,
        homeDirectory: root,
        runtimeFactory: {
            async create({ instances }: Parameters<
                import("../../../src/server/runtime/Factory.ts").ControlRuntimeFactory["create"]
            >[0]) {
                const instance = instances.registry.get("retry-local")!;
                const close = instance.close.bind(instance);
                restoreInstanceClose = () => {
                    instance.close = close;
                };
                instance.close = async () => {
                    throw cleanupFailure;
                };
                throw failure;
            },
        } as never,
        xdgRuntimeDir: root,
    });

    await assert.rejects(server.start(), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], failure);
        assert.equal(containsError(error, cleanupFailure), true);
        return true;
    });
    assert.notEqual(server.config, undefined);
    restoreInstanceClose();
    await server.stop();
    assert.equal(server.config, undefined);
});

function testState() {
    return {
        async initialize() {},
        async start() {},
        async reconcile() {},
        async close() {},
    };
}

function containsError(error: unknown, expected: unknown): boolean {
    if (error === expected) return true;
    if (!(error instanceof AggregateError)) return false;
    return error.errors.some((entry) => containsError(entry, expected));
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for condition.");
}
