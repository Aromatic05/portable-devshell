import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import {
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
} from "@portable-devshell/shared";

import { Control } from "../../../src/Control.ts";
import { ControlInstances } from "../../../src/instance/index.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

test("Control interleaves domain and server lifecycle phases in dependency order", async (t) => {
    const xdgRuntimeDir = await createTestTempDirectory("control-server-phases");
    t.after(async () => {
        await rm(xdgRuntimeDir, { force: true, recursive: true });
    });
    const events: string[] = [];
    const server = new Control({
        configStore: {
            async readOrCreate() {
                return createDefaultControlConfig();
            },
        } as never,
        factory: {
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
                        markReady() {
                            events.push("server.markReady");
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
        "server.markReady",
    ]);
    await server.stop();
});

test("Control becomes ready without waiting for historical cleanup recovery", async (t) => {
    const xdgRuntimeDir = await createTestTempDirectory("control-debt-ready");
    t.after(async () => {
        await rm(xdgRuntimeDir, { force: true, recursive: true });
    });
    let ready = false;
    let backgroundAttempted = false;
    const control = new Control({
        configStore: {
            async readOrCreate() { return createDefaultControlConfig(); },
        } as never,
        factory: {
            async create(options: { instances: { reconcile(): Promise<void> } }) {
                // Simulate an old SSH provider that never finishes retiring.
                options.instances.reconcile = async () => {
                    backgroundAttempted = true;
                    await new Promise<void>(() => undefined);
                };
                return {
                    state: {
                        async initialize() {},
                        async start() {},
                        async reconcile() {},
                        async close() {},
                    },
                    server: {
                        async prepare() {},
                        async startTransport() {},
                        async startHosts() {},
                        markReady() { ready = true; },
                        async stop() {},
                    },
                };
            },
        } as never,
        xdgRuntimeDir,
    });
    await control.start();
    assert.equal(ready, true);
    assert.equal(backgroundAttempted, false, "recovery is deferred until Control is ready");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(backgroundAttempted, true, "historical debt starts recovering independently");
    // The forever-pending legacy Worker must not hold shutdown hostage.
    await control.stop();
});

test("recovery attempts independent pending debts while a sibling provider never responds", async () => {
    const instances = new ControlInstances();
    const attempted: string[] = [];
    instances.attachRuntime({
        editor: {
            async listCleanupDebts() {
                return [
                    { instance: "blocked-ssh", state: "pending" },
                    { instance: "healthy-container", state: "pending" },
                    { instance: "healthy-3", state: "pending" },
                    { instance: "healthy-4", state: "pending" },
                    { instance: "healthy-5", state: "pending" },
                    { instance: "healthy-6", state: "pending" },
                    { instance: "old-orphan", state: "orphaned" },
                ];
            },
            async reconcileCleanupDebt(name: string) {
                attempted.push(name);
                if (name === "blocked-ssh")
                    await new Promise<void>(() => undefined);
            },
        },
        toolCallEndpoint: {},
    } as never);
    const controller = new AbortController();
    void instances.reconcile(controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(attempted, [
        "blocked-ssh", "healthy-container", "healthy-3", "healthy-4",
        "healthy-5", "healthy-6",
    ], "a stalled first slot must not starve fifth and sixth debts");
    controller.abort();
});

test("recovery fences a retired Control generation against same-name runtime reuse", async () => {
    const instances = new ControlInstances();
    const config = createDefaultControlConfig();
    config.instances = [
        normalizeConfigInstanceDraft({ name: "reused-local", provider: "local" }),
    ];
    await instances.load(config);
    let complete!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const actualCleanup: string[] = [];
    let cleared = 0;
    instances.onRecoveryFenceCleared(() => { cleared++; });
    instances.attachRuntime({
        editor: {
            async listCleanupDebts() {
                return [{ instance: "reused-local", state: "pending" }];
            },
            async reconcileCleanupDebt() {
                started();
                await pending;
                actualCleanup.push("old-generation-retired");
            },
        },
        toolCallEndpoint: {},
    } as never);
    const oldRecovery = instances.reconcile();
    await entered;
    await instances.close();
    instances.reset();
    await instances.load(config);
    assert.equal(instances.registry.get("reused-local"), undefined,
        "a new Control must not create a same-name generation before the old retirement settles");
    complete();
    await oldRecovery;
    assert.deepEqual(actualCleanup, ["old-generation-retired"]);
    assert.equal(cleared, 1, "the Control must refresh its editor after old debt settles");
    instances.reset();
    await instances.load(config);
    assert.ok(instances.registry.get("reused-local"));
    await instances.close();
});

test("Control restart quarantines an in-flight old cleanup until a fresh configuration load", async (t) => {
    const xdgRuntimeDir = await createTestTempDirectory("control-cross-generation-cleanup");
    t.after(async () => { await rm(xdgRuntimeDir, { recursive: true, force: true }); });
    const config = createDefaultControlConfig();
    config.instances = [normalizeConfigInstanceDraft({
        name: "reused-local", provider: "local",
    })];
    const resources = new Map<string, number>();
    let generation = 0;
    let unblock!: () => void;
    let oldStarted!: () => void;
    let thirdStarted!: () => void;
    const oldPending = new Promise<void>((resolve) => { unblock = resolve; });
    const oldEntered = new Promise<void>((resolve) => { oldStarted = resolve; });
    const thirdReady = new Promise<void>((resolve) => { thirdStarted = resolve; });
    const control = new Control({
        configStore: { async readOrCreate() { return config; } } as never,
        factory: {
            async create(options: { instances: ControlInstances }) {
                const current = ++generation;
                if (options.instances.registry.get("reused-local") !== undefined)
                    resources.set("reused-local", current);
                options.instances.attachRuntime({
                    editor: {
                        async listCleanupDebts() {
                            return current === 1
                                ? [{ instance: "reused-local", state: "pending" }]
                                : [];
                        },
                        async reconcileCleanupDebt() {
                            oldStarted();
                            await oldPending;
                            resources.delete("reused-local");
                        },
                    },
                    toolCallEndpoint: {},
                } as never);
                if (current === 3) thirdStarted();
                return {
                    state: {
                        async initialize() {}, async start() {},
                        async reconcile() {}, async close() {},
                    },
                    server: {
                        async prepare() {}, async startTransport() {},
                        async startHosts() {}, markReady() {}, async stop() {},
                    },
                };
            },
        } as never,
        xdgRuntimeDir,
    });
    try {
        await control.start();
        await oldEntered;
        await control.restart();
        assert.equal(generation, 2);
        assert.equal(resources.get("reused-local"), 1,
            "a new Control generation must defer loading the still-retiring name");
        unblock();
        await thirdReady;
        assert.equal(generation, 3);
        assert.equal(resources.get("reused-local"), 3,
            "old cleanup completed before the replacement resource was admitted");
    } finally {
        unblock();
        await control.stop();
    }
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
    const server = new Control({
        configStore: {
            async readOrCreate() {
                return createDefaultControlConfig();
            },
        } as never,
        factory: {
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
                        markReady() {},
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
    const server = new Control({
        configStore: {
            async readOrCreate() {
                return createDefaultControlConfig();
            },
        } as never,
        factory: {
            async create() {
                creates += 1;
                return {
                    state: testState(),
                    server: {
                        async prepare() {},
                        async startTransport() {},
                        async startHosts() {},
                        markReady() {},
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
    const server = new Control({
        configStore: { async readOrCreate() { return config; } } as never,
        homeDirectory: root,
        factory: {
            async create({ instances }: Parameters<
                import("../../../src/Factory.ts").ControlFactory["create"]
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
    const server = new Control({
        configStore: { async readOrCreate() { return config; } } as never,
        homeDirectory: root,
        factory: {
            async create({ instances }: Parameters<
                import("../../../src/Factory.ts").ControlFactory["create"]
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
