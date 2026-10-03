import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
    ConfigEditorCoordinator,
    InstanceRegistry,
    createDefaultControlConfig,
} from "../../../../src/testing.ts";
import { ContextModule } from "../../../../src/context/Module.ts";
import type { InstanceDescriptor } from "@portable-devshell/core";
import { normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

for (const descriptorState of ["present", "missing"] as const) {
    test(`deleting an active Context scope settles ownership debt with ${descriptorState} descriptor`, async (t) => {
        const hasLiveDescriptor = descriptorState === "present";
        const home = await createTestTempDirectory("context-retirement-chain");
        t.after(async () => await rm(home, { force: true, recursive: true }));

        const instanceName = "retirement-local";
        const workspace = join(home, "workspace");
        const events: string[] = [];
        let ready = true;
        let allowAlertsRelease = false;
        const instances = new InstanceRegistry([]);
        const worker = {
            managementMode: "controllerManaged" as const,
            snapshot: () => ({
                daemonState: ready ? "running" : "stopped",
                ready,
            }),
            async start() {
                assert.equal(instances.get(instanceName), undefined);
                events.push("worker.start.cleanup-only");
                ready = true;
            },
            async stop() {
                events.push("worker.stop");
                ready = false;
            },
            async prepareWorkspace(path: string) {
                assert.equal(ready, true);
                return {
                    projectMemoryAgentFile: join(path, "AGENTS.md"),
                    projectMemoryDirectory: path,
                    projectMemoryPresent: false,
                    temporaryDirectory: join(path, ".tmp"),
                    workspace: path,
                };
            },
            async releaseAlerts(path: string) {
                assert.equal(ready, true);
                assert.equal(instances.get(instanceName), undefined);
                events.push(
                    allowAlertsRelease
                        ? "alerts.release.success"
                        : "alerts.release.failure",
                );
                if (!allowAlertsRelease)
                    throw new Error(
                        "alerts release is temporarily unavailable",
                    );
                assert.equal(path, workspace);
            },
            async retireRuntime() {
                events.push("worker.retireRuntime");
            },
            async retireProviderResources() {
                events.push("worker.retireProviderResources");
            },
            async close() {
                events.push("worker.close");
            },
        };
        const descriptor = {
            approval: {
                async retire() {},
                close() {},
            },
            enabled: true,
            goal: {
                async stopAll() {},
            },
            mcpEnabled: true,
            mcpPath: `/${instanceName}/mcp`,
            modelExtensions: [],
            name: instanceName,
            provider: "local" as const,
            todo: {
                async cancelAll() {},
            },
            worker,
        } as unknown as InstanceDescriptor;
        instances.add(descriptor);
        instances.markOwned(instanceName);
        let descriptorMapCalls = 0;

        const config = createDefaultControlConfig();
        config.mcp.enabled = false;
        config.instances = [
            normalizeConfigInstanceDraft({
                mcp: { enabled: true },
                name: instanceName,
                provider: "local",
                security: { mode: "disabled" },
            }),
        ];
        const contexts = new ContextModule({
            contextFile: join(home, "contexts.json"),
            instances,
        });
        await contexts.initialize();
        const withWorkspace = await contexts.registry.create({
            principal: "local",
        });
        await contexts.environment.prepareLocal(
            withWorkspace.ctxId,
            instanceName,
            workspace,
        );
        const withoutWorkspace = await contexts.registry.create({
            principal: "local",
        });
        await contexts.registry.attachEnvironment(withoutWorkspace.ctxId, {
            instance: instanceName,
        });
        assert.deepEqual(await contexts.registry.listEnvironmentCleanup(), []);

        instances.retainConnectionReference(
            instanceName,
            descriptor.worker,
            withWorkspace.ctxId,
            true,
        );
        instances.retainConnectionReference(
            instanceName,
            descriptor.worker,
            withoutWorkspace.ctxId,
            true,
        );
        ready = false;
        if (!hasLiveDescriptor)
            await instances.retireGeneration(instanceName, descriptor);

        let currentConfig = config;
        const cleanupDebtFile = join(home, "instance-cleanup.json");
        const coordinator = new ConfigEditorCoordinator({
            cleanupDebtFile,
            configStore: {
                async write(nextConfig) {
                    currentConfig = nextConfig;
                },
            },
            detachContextInstance: async (instance) => {
                await contexts.detachInstance(instance);
            },
            reconcileContextInstanceCleanup: async (
                instance,
                cleanupDescriptor,
            ) => {
                await contexts.cleanup.reconcileInstance(instance, {
                    releaseAlerts: async (path) => {
                        assert.ok(cleanupDescriptor);
                        if (!cleanupDescriptor.worker.snapshot().ready)
                            await cleanupDescriptor.worker.start();
                        await cleanupDescriptor.worker.releaseAlerts(path);
                    },
                    releaseInstanceReference: async (ctxId) => {
                        const released = instances.releaseConnectionReference(
                            instance,
                            ctxId,
                        );
                        assert.notEqual(released, undefined);
                        events.push(`reference.release:${ctxId}`);
                    },
                });
            },
            getConfig: () => currentConfig,
            instanceConfigMapper: {
                map() {
                    descriptorMapCalls += 1;
                    return descriptor;
                },
            } as never,
            instanceRegistry: instances,
            setConfig: (nextConfig) => {
                currentConfig = nextConfig;
            },
        });

        const warnings: unknown[] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => warnings.push(...args);
        try {
            await coordinator.deleteInstance({ instanceName });
        } finally {
            console.warn = originalWarn;
        }

        assert.equal(warnings.length, 1);
        assert.equal(instances.get(instanceName), undefined);
        assert.equal(currentConfig.instances.length, 0);
        assert.deepEqual(
            (await contexts.registry.listEnvironmentCleanup()).map(
                ({ ctxId, cleanup }) => ({
                    ctxId,
                    cleanup,
                }),
            ),
            [
                {
                    ctxId: withWorkspace.ctxId,
                    cleanup: {
                        instance: instanceName,
                        kind: "alerts",
                        workspace,
                    },
                },
            ],
        );
        const persistedInstanceDebt = JSON.parse(
            await readFile(cleanupDebtFile, "utf8"),
        ) as Array<{ instance: { name: string }; operation: string }>;
        assert.equal(persistedInstanceDebt[0]?.instance.name, instanceName);
        assert.equal(persistedInstanceDebt[0]?.operation, "delete");
        assert.equal(events.includes("worker.close"), false);
        assert.equal(events.includes("worker.retireRuntime"), false);
        assert.equal(events.includes("worker.stop"), false);

        allowAlertsRelease = true;
        await coordinator.reconcileCleanupDebt();

        for (const context of [withWorkspace, withoutWorkspace]) {
            const current = await contexts.registry.lookup(context.ctxId, {
                principal: "local",
            });
            assert.equal(current.status, "active");
            assert.deepEqual(current.environments, []);
        }
        assert.deepEqual(await contexts.registry.listEnvironmentCleanup(), []);
        assert.deepEqual(
            JSON.parse(await readFile(cleanupDebtFile, "utf8")),
            [],
        );
        assert.equal(instances.get(instanceName), undefined);
        assert.equal(descriptorMapCalls, hasLiveDescriptor ? 0 : 1);
        assert.equal(
            events.filter((event) => event === "worker.start.cleanup-only")
                .length,
            1,
        );
        assert.equal(
            events.filter((event) => event === "alerts.release.success").length,
            1,
        );
        assert.ok(
            events.indexOf("alerts.release.success") <
                events.indexOf("worker.retireRuntime"),
        );
        assert.ok(
            events.indexOf("alerts.release.success") <
                events.indexOf("worker.retireProviderResources"),
        );
        assert.ok(
            events.indexOf("alerts.release.success") <
                events.indexOf("worker.close"),
        );
        assert.equal(events.includes("worker.stop"), false);
    });
}
