import assert from "node:assert/strict";
import test from "node:test";

import { InstanceRegistry } from "../../../../src/instance/Registry.ts";
import {
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
    type ControlConfig,
} from "@portable-devshell/shared";
import { ConfigEngine } from "../../../../src/config/engine/index.ts";
import { InstanceChangeHub } from "../../../../src/instance/Change.ts";
import { InstanceEditorCoordinator } from "../../../../src/instance/editor/index.ts";
import { InstanceCreateCoordinator } from "../../../../src/instance/editor/create/index.ts";
import {
    createTestInstance,
    testRuntimeHooks,
} from "../../../support/InstanceRuntime.ts";

test("a draining Instance deletion does not block unrelated config commits", async () => {
    let config = configWithInstance();
    config.instances.push(normalizeConfigInstanceDraft({
        name: "healthy-local",
        provider: "local",
        security: { mode: "disabled" },
    }));
    const oldInstance = createTestInstance(config.instances[0]!);
    const healthy = createTestInstance(config.instances[1]!);
    const lease = oldInstance.lifecycle.acquireLease();
    const registry = new InstanceRegistry([oldInstance, healthy]);
    const coordinator = createCoordinator({
        config,
        registry,
        setConfig: (next) => { config = next; },
        hooks: testRuntimeHooks(),
    });
    const pendingDelete = coordinator.deleteInstance({ instanceName: "demo-local" });
    try {
        await Promise.race([
            coordinator.updateInstanceConfig({
                instanceName: "healthy-local",
                patch: { security: { mode: "workspace" } },
            }),
            new Promise<never>((_resolve, reject) =>
                setTimeout(() => reject(new Error("unrelated config update blocked by drain")), 2000)),
        ]);
        assert.equal(config.instances.find((entry) => entry.name === "healthy-local")?.security.mode, "workspace");
    } finally {
        lease.release();
    }
    await pendingDelete;
});

test("concurrent debt recovery joins deletion and never retires newly created same-name resources", async () => {
    let config = configWithInstance();
    const resources = new Map([["demo-local", "old"]]);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let retirements = 0;
    const hooks = {
        ...testRuntimeHooks(),
        createRuntimeInstance: (instance: ControlConfig["instances"][number]) => {
            resources.set(instance.name, "new");
            return createTestInstance(instance);
        },
    };
    const original = createTestInstance(config.instances[0]!);
    const registry = new InstanceRegistry([original]);
    const changes = new InstanceChangeHub();
    const engine = new ConfigEngine({
        configStore: { async write(next) { config = next; } },
        getConfig: () => config,
        runtimePreflight: { async assertAvailable() {} },
        setConfig: (next) => { config = next; },
    });
    const editor = new InstanceEditorCoordinator({
        ...hooks, engine, instanceChanges: changes, instanceRegistry: registry,
    });
    const creator = new InstanceCreateCoordinator({
        ...hooks, engine, instanceChanges: changes, instanceRegistry: registry,
        assertCleanupSettled: (instance, reconcile) =>
            editor.assertInstanceCleanupSettled(instance, reconcile),
    });
    editor.registerInstanceDeleteRetirement(async (instance) => {
        retirements += 1;
        if (retirements === 1) {
            notifyStarted();
            await blocked;
        }
        resources.delete(instance.name);
    });

    const deletion = editor.deleteInstance({ instanceName: "demo-local" });
    try {
        await started;
        const recovery = editor.reconcileCleanupDebt("demo-local");
        let recreated = false;
        const creating = creator.createInstance({
            name: "demo-local", provider: "local", security: { mode: "disabled" },
        }).then((result) => {
            recreated = true;
            return result;
        });
        // All clients can run while the old deletion owns this instance
        // name, but none may commit a replacement before it releases it.
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(retirements, 1, "a pending cleanup cannot be replayed");
        assert.equal(recreated, false, "old cleanup must fence same-name creation");
        assert.equal(resources.get("demo-local"), "old");
        unblock();
        const [deleted, , created] = await Promise.all([deletion, recovery, creating]);
        assert.equal((deleted as Record<string, unknown>).cleanupPending, false);
        assert.equal(created.name, "demo-local");
        assert.equal(retirements, 1, "only one retirement may run for the old generation");
        assert.equal(resources.get("demo-local"), "new");
        assert.equal(registry.get("demo-local") !== undefined, true);
    } finally {
        unblock();
        await deletion;
    }
});

test("failed delete persistence releases the instance cleanup reservation", async () => {
    let config = configWithInstance();
    let failPersist = true;
    const descriptor = createTestInstance(config.instances[0]!);
    const registry = new InstanceRegistry([descriptor]);
    const changes = new InstanceChangeHub();
    const engine = new ConfigEngine({
        configStore: {
            async write(next) {
                if (failPersist) throw new Error("injected config write failure");
                config = next;
            },
        },
        getConfig: () => config,
        runtimePreflight: { async assertAvailable() {} },
        setConfig: (next) => { config = next; },
    });
    const hooks = testRuntimeHooks();
    const editor = new InstanceEditorCoordinator({
        ...hooks, engine, instanceChanges: changes, instanceRegistry: registry,
    });
    await assert.rejects(
        editor.deleteInstance({ instanceName: "demo-local" }),
        /injected config write failure/u,
    );
    await editor.assertInstanceCleanupSettled("demo-local", false);
    assert.equal(registry.get("demo-local"), descriptor);
    assert.equal(config.instances.length, 1);
    failPersist = false;
    const deleted = await editor.deleteInstance({ instanceName: "demo-local" }) as Record<string, unknown>;
    assert.equal(deleted.cleanupPending, false);
    await editor.assertInstanceCleanupSettled("demo-local", false);
});

test("failed generation retirement leaves committed rebuild debt until reconciliation", async () => {
    let config = configWithInstance();
    const original = createTestInstance(config.instances[0]!);
    const registry = new InstanceRegistry([original]);
    const generations: ReturnType<typeof createTestInstance>[] = [];
    let retirementCalls = 0;
    const coordinator = createCoordinator({
        config,
        registry,
        setConfig: (next) => {
            config = next;
        },
        hooks: {
            ...testRuntimeHooks(),
            createRuntimeInstance: (instance) => {
                const descriptor = createTestInstance(instance);
                generations.push(descriptor);
                return descriptor;
            },
        },
    });
    coordinator.registerInstanceGenerationRetirement(async () => {
        retirementCalls += 1;
        if (retirementCalls === 1)
            throw new Error("generation retirement failed once");
    });

    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(...args);
    try {
        await coordinator.updateInstanceConfig({
            instanceName: "demo-local",
            patch: { security: { mode: "workspace" } },
        });
    } finally {
        console.warn = originalWarn;
    }

    assert.equal(retirementCalls, 1);
    assert.equal(config.instances[0]?.security.mode, "workspace");
    assert.equal(original.lifecycle.retired, true);
    assert.equal(generations.length, 1);
    assert.equal(registry.get("demo-local"), undefined);
    assert.equal(warnings.length, 1);
    await coordinator.assertInstanceCleanupSettled("demo-local");
    assert.equal(retirementCalls, 2);
    assert.equal(generations.length, 2);
    assert.equal(registry.get("demo-local"), generations[1]);
    assert.equal(registry.get("demo-local")?.lifecycle.active, true);
});

test("disable wait-cancel failure is cleanup debt after admission drains", async () => {
    let config = configWithInstance();
    const workerStops: number[] = [];
    const instance = createTestInstance(config.instances[0]!, {
        async stop() {
            workerStops.push(1);
            return {
                daemonState: "stopped",
                ready: false,
                status: "stopped",
            };
        },
    });
    const registry = new InstanceRegistry([instance]);
    const coordinator = createCoordinator({
        config,
        registry,
        setConfig: (next) => {
            config = next;
        },
        hooks: testRuntimeHooks(),
    });
    coordinator.registerInstanceDisableRetirement(async () => {
        throw new Error("wait cancellation failed");
    });

    await coordinator.disableInstance({ instanceName: "demo-local" });

    assert.equal(config.instances[0]?.enabled, false);
    assert.equal(registry.get("demo-local"), undefined);
    assert.deepEqual(workerStops, [1]);
    await assert.rejects(
        coordinator.assertInstanceCleanupSettled("demo-local"),
        /incomplete lifecycle cleanup/u,
    );
});

test("delete cleanup debt retries provider retirement before finalizing the generation", async () => {
    let config = configWithInstance();
    let providerRetirements = 0;
    let finalizations = 0;
    const instance = createTestInstance(config.instances[0]!, {
        async retireProviderResources() {
            providerRetirements += 1;
            if (providerRetirements === 1)
                throw new Error("provider cleanup failed once");
        },
        async close() {
            finalizations += 1;
        },
    });
    const registry = new InstanceRegistry([instance]);
    const coordinator = createCoordinator({
        config,
        registry,
        setConfig: (next) => {
            config = next;
        },
        hooks: {
            ...testRuntimeHooks(),
            finalizeRuntimeInstance: async () => {
                finalizations += 1;
            },
        },
    });

    const deleted = await coordinator.deleteInstance({ instanceName: "demo-local" }) as Record<string, unknown>;
    assert.equal(deleted.cleanupPending, true);
    assert.deepEqual(config.instances, []);
    assert.equal(registry.get("demo-local"), undefined);
    assert.equal(providerRetirements, 1);
    assert.equal(finalizations, 0);

    await coordinator.reconcileCleanupDebt("demo-local");
    await coordinator.assertInstanceCleanupSettled("demo-local");
    assert.equal(providerRetirements, 2);
    assert.equal(finalizations, 1);
});

test("cleanup-only Worker stops after a failed Context cleanup", async () => {
    const events: string[] = [];
    const instance = createTestInstance(configWithInstance().instances[0]!, {
        async start() {
            events.push("start");
        },
        async releaseAlerts() {
            events.push("releaseAlerts");
            throw new Error("Context cleanup failed");
        },
        async stop() {
            events.push("stop");
        },
    });

    await assert.rejects(
        instance.withWorkerForCleanup(async (worker) => {
            await worker.releaseAlerts("/workspace");
        }),
        /Context cleanup failed/u,
    );
    assert.deepEqual(events, ["start", "releaseAlerts", "stop"]);
});

test("cleanup reuses an already-ready Worker without stopping it", async () => {
    const events: string[] = [];
    const instance = createTestInstance(configWithInstance().instances[0]!, {
        async start() {
            events.push("start");
        },
        async releaseReference() {
            events.push("releaseReference");
        },
        async stop() {
            events.push("stop");
        },
    });
    await instance.supervision.lifecycle.start();
    events.length = 0;

    await instance.withWorkerForCleanup(async (worker) => {
        await worker.releaseReference("ctx-test");
    });
    assert.deepEqual(events, ["releaseReference"]);
});

test("disabling a self-managed Instance does not stop its Worker", async () => {
    const instance = createTestInstance(configWithInstance().instances[0]!, {
        managementMode: "selfManaged",
        async stop() {
            throw new Error("self-managed Worker must not be stopped by Control");
        },
    });

    await instance.stopWorkerForDisable();
});

function configWithInstance(): ControlConfig {
    const config = createDefaultControlConfig();
    config.mcp.enabled = true;
    config.instances = [
        normalizeConfigInstanceDraft({
            name: "demo-local",
            provider: "local",
            security: { mode: "disabled" },
        }),
    ];
    return config;
}

function createCoordinator(input: {
    config: ControlConfig;
    registry: InstanceRegistry;
    setConfig(next: ControlConfig): void;
    hooks: ReturnType<typeof testRuntimeHooks>;
}): InstanceEditorCoordinator {
    const engine = new ConfigEngine({
        configStore: {
            async write(next) {
                input.setConfig(next);
            },
        },
        getConfig: () => input.config,
        runtimePreflight: { async assertAvailable() {} },
        setConfig: (next) => {
            input.config = next;
            input.setConfig(next);
        },
    });
    return new InstanceEditorCoordinator({
        ...input.hooks,
        engine,
        instanceChanges: new InstanceChangeHub(),
        instanceRegistry: input.registry,
    });
}
