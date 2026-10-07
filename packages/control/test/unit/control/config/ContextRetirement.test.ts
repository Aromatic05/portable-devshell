import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
    createContextRuntime,
} from "@portable-devshell/core/context";
import {
    InstanceRegistry,
    type WorkerInstance,
} from "@portable-devshell/core/instance";
import {
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
    type ControlConfig,
} from "@portable-devshell/shared";
import { ConfigEngine } from "../../../../src/config/engine/index.ts";
import { InstanceChangeHub } from "../../../../src/instance/Change.ts";
import { InstanceEditorCoordinator } from "../../../../src/instance/editor/index.ts";
import { createTestInstance } from "../../../support/ControlFixtures.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

for (const descriptorState of ["present", "missing"] as const) {
    test(`instance deletion retries Context cleanup debt with ${descriptorState} descriptor`, async (t) => {
        const home = await createTestTempDirectory("context-retirement-chain");
        t.after(async () => await rm(home, { force: true, recursive: true }));

        const instanceName = "retirement-local";
        const workspace = join(home, "workspace");
        const events: string[] = [];
        let ready = true;
        let allowAlertsRelease = false;
        let releaseAttempts = 0;
        let factoryCalls = 0;
        const makeWorker = (): WorkerInstance => ({
            managementMode: "controllerManaged",
            snapshot: () => ({ daemonState: ready ? "running" : "stopped", ready }),
            async start() {
                events.push("worker.start.cleanup-only");
                ready = true;
                return { daemonState: "running", ready: true };
            },
            async stop() {
                events.push("worker.stop");
                ready = false;
                return { daemonState: "stopped", ready: false };
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
                releaseAttempts += 1;
                events.push(
                    allowAlertsRelease
                        ? "alerts.release.success"
                        : "alerts.release.failure",
                );
                assert.equal(path, workspace);
                if (!allowAlertsRelease)
                    throw new Error("alerts release is temporarily unavailable");
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
        } as unknown as WorkerInstance);

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
        const instances = new InstanceRegistry([
            createTestInstance(makeWorker(), {
                enabled: true,
                mcpEnabled: true,
                mcpPath: `/${instanceName}/mcp`,
                modelExtensions: [],
                name: instanceName,
                provider: "local",
            }),
        ]);
        const contexts = createContextRuntime({
            contextFile: join(home, "contexts.json"),
            instances,
        });
        await contexts.initialize();
        const context = await contexts.api.registry.create({ principal: "local" });
        await contexts.api.environment.prepareLocal(
            context.ctxId,
            instanceName,
            workspace,
        );
        ready = false;
        if (descriptorState === "missing")
            await instances.remove(instanceName);

        let currentConfig: ControlConfig = config;
        const engine = new ConfigEngine({
            configStore: {
                async write(nextConfig) {
                    currentConfig = nextConfig;
                },
            },
            getConfig: () => currentConfig,
            setConfig: (nextConfig) => {
                currentConfig = nextConfig;
            },
        });
        const cleanupDebtFile = join(home, "instance-cleanup.json");
        const coordinator = new InstanceEditorCoordinator({
            cleanupDebtFile,
            createRuntimeInstance: () => {
                factoryCalls += 1;
                return createTestInstance(makeWorker(), {
                    enabled: true,
                    mcpEnabled: true,
                    mcpPath: `/${instanceName}/mcp`,
                    modelExtensions: [],
                    name: instanceName,
                    provider: "local",
                });
            },
            detachContextInstance: async (instance) => {
                await contexts.api.detachInstance(instance);
            },
            engine,
            instanceChanges: new InstanceChangeHub(),
            instanceRegistry: instances,
            reconcileContextInstanceCleanup: async (instance, target) =>
                await contexts.api.cleanup.reconcileInstance(instance, target),
            retireRuntimeInstance: async () => {},
            finalizeRuntimeInstance: async (descriptor) => {
                await descriptor.close();
            },
            updateApprovalPolicy: async () => {},
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
        assert.equal(currentConfig.instances.length, 0);
        assert.deepEqual(
            (await contexts.api.registry.listEnvironmentCleanup()).map(
                ({ ctxId, cleanup }) => ({ ctxId, cleanup }),
            ),
            [
                {
                    ctxId: context.ctxId,
                    cleanup: {
                        instance: instanceName,
                        kind: "alerts",
                        workspace,
                    },
                },
            ],
        );
        assert.equal(releaseAttempts, 1);
        assert.equal(events.includes("worker.close"), false);

        allowAlertsRelease = true;
        await coordinator.reconcileCleanupDebt();

        assert.deepEqual(await contexts.api.registry.listEnvironmentCleanup(), []);
        assert.deepEqual(
            JSON.parse(await readFile(cleanupDebtFile, "utf8")),
            [],
        );
        assert.equal(releaseAttempts, 2);
        assert.equal(factoryCalls, descriptorState === "missing" ? 1 : 0);
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
