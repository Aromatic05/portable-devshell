import assert from "node:assert/strict";
import test from "node:test";

import { InstanceRegistry } from "@portable-devshell/core/instance";
import {
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
    type ControlConfig,
} from "@portable-devshell/shared";
import { ConfigEngine } from "../../../../src/config/engine/index.ts";
import { InstanceChangeHub } from "../../../../src/instance/Change.ts";
import { InstanceEditorCoordinator } from "../../../../src/instance/editor/index.ts";
import {
    createTestInstance,
    testRuntimeHooks,
} from "../../../support/InstanceRuntime.ts";

test("failed retirement rollback installs a fresh active generation", async () => {
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
            retireRuntimeInstance: async () => {
                retirementCalls += 1;
                throw new Error("approval retirement failed");
            },
        },
    });

    await assert.rejects(
        coordinator.updateInstanceConfig({
            instanceName: "demo-local",
            patch: { security: { mode: "workspace" } },
        }),
        /approval retirement failed/u,
    );
    assert.equal(retirementCalls, 1);
    assert.equal(config.instances[0]?.security.mode, "disabled");
    assert.equal(original.retired, true);
    assert.equal(generations.length, 2);
    assert.equal(registry.get("demo-local"), generations[1]);
    assert.notStrictEqual(registry.get("demo-local"), original);
    assert.equal(registry.get("demo-local")?.retired, false);
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

    await coordinator.deleteInstance({ instanceName: "demo-local" });
    assert.deepEqual(config.instances, []);
    assert.equal(registry.get("demo-local"), undefined);
    assert.equal(providerRetirements, 1);
    assert.equal(finalizations, 0);

    await coordinator.reconcileCleanupDebt("demo-local");
    await coordinator.assertInstanceCleanupSettled("demo-local");
    assert.equal(providerRetirements, 2);
    assert.equal(finalizations, 1);
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
