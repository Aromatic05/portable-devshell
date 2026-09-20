import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import {
    ConfigEditorCoordinator,
    InstanceRegistry,
    InstanceRegistryFactory,
    createDefaultControlConfig,
} from "../../../../src/testing.ts";
import {
    MASKED_CONFIG_TOKEN,
    normalizeConfigInstanceDraft,
    type ControlConfig,
    type JsonValue,
} from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

test("config editor returns each patch apply summary to the initiating request", async () => {
    let config = createConfig();
    const registry = new InstanceRegistryFactory().build(config);
    const writes: unknown[] = [];
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(nextConfig);
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: registry,
        runtimePreflight: { async assertAvailable() {} },
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    const view = service.getConfigView() as {
        instances: Array<{ security: { effectiveMode: string; mode: string } }>;
    };
    assert.equal(view.instances[0]?.security.mode, "disabled");
    assert.equal(view.instances[0]?.security.effectiveMode, "disabled");

    const configView = service.getConfigView() as {
        instances: Array<Record<string, unknown>>;
    } & Record<string, unknown>;
    const validated = service.validateConfigDraft({
        ...configView,
        instances: [
            {
                ...configView.instances[0],
                approvalPolicy: { mode: "ask" },
                security: { mode: "workspace" },
            },
        ],
    } as unknown as JsonValue) as {
        instances: Array<{ security: { effectiveMode: string; mode: string } }>;
    };
    assert.equal(validated.instances[0]?.security.mode, "workspace");
    assert.equal(config.instances[0]?.security.mode, "disabled");

    const instanceResult = (await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: {
            approvalPolicy: { mode: "ask" },
            security: { mode: "workspace" },
        },
    })) as { appliedChanges: Array<{ kind: string; target: string }> };
    assert.equal(writes.length, 1);
    assert.equal(config.instances[0]?.security.mode, "workspace");
    assert.equal(
        registry.get("demo-local")?.worker.snapshot().effectiveSecurityMode,
        "workspace",
    );

    const mcpResult = (await service.updateMcpConfig({
        patch: {
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 17891,
            publicBaseUrl: "http://127.0.0.1:17891",
        },
    })) as {
        appliedChanges: Array<{ kind: string; target: string }>;
        restartControlRequired: boolean;
    };
    const webResult = (await service.updateWebConfig({
        patch: {
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 17892,
            publicBaseUrl: "127.0.0.1",
        },
    })) as {
        appliedChanges: Array<{ kind: string; target: string }>;
        restartControlRequired: boolean;
    };
    const authResult = (await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: {
            mcp: { auth: "token", token: "0123456789abcdef0123456789abcdef" },
        },
    })) as {
        appliedChanges: Array<{ kind: string; target: string }>;
        affectedMcpEndpoints: string[];
    };

    assert.deepEqual(instanceResult.appliedChanges, [
        { kind: "instance.updated", target: "demo-local" },
    ]);
    assert.deepEqual(mcpResult.appliedChanges, [
        { kind: "mcp.endpoint.updated", target: "mcp" },
    ]);
    assert.equal(mcpResult.restartControlRequired, true);
    assert.deepEqual(webResult.appliedChanges, [
        { kind: "web.updated", target: "web" },
    ]);
    assert.equal(webResult.restartControlRequired, true);
    assert.deepEqual(authResult.appliedChanges, [
        { kind: "instance.updated", target: "demo-local" },
    ]);
    assert.deepEqual(authResult.affectedMcpEndpoints, ["/demo-local/mcp"]);
});

test("config batch update persists instance, MCP, and Web changes as one transaction", async () => {
    let config = createConfig();
    const writes: ControlConfig[] = [];
    let runtimeApplyCalls = 0;
    const registry = new InstanceRegistryFactory().build(config);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(nextConfig);
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: registry,
        runtimePreflight: { async assertAvailable() {} },
        runtimeApply: {
            async apply() {
                runtimeApplyCalls += 1;
                return false;
            },
        },
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    const result = (await service.updateConfig({
        instance: {
            instanceName: "demo-local",
            patch: {
                approvalPolicy: { mode: "ask" },
                security: { mode: "workspace" },
            },
        },
        mcp: { listenPort: 17891, publicBaseUrl: "http://127.0.0.1:17891" },
        web: {
            auth: "token",
            enabled: true,
            listenPort: 17892,
            token: "a".repeat(48),
        },
    })) as {
        appliedChanges: Array<{ kind: string; target: string }>;
        restartControlRequired: boolean;
    };

    assert.equal(writes.length, 1);
    assert.equal(runtimeApplyCalls, 1);
    assert.equal(config.instances[0]?.security.mode, "workspace");
    assert.equal(config.instances[0]?.approvalPolicy?.mode, "ask");
    assert.equal(config.mcp.listenPort, 17891);
    assert.equal(config.web.listenPort, 17892);
    assert.deepEqual(config.web.auth, { mode: "token", token: "a".repeat(48) });
    assert.equal(
        registry.get("demo-local")?.worker.snapshot().effectiveSecurityMode,
        "workspace",
    );
    assert.deepEqual(result.appliedChanges, [
        { kind: "instance.updated", target: "demo-local" },
        { kind: "mcp.endpoint.updated", target: "mcp" },
        { kind: "web.updated", target: "web" },
    ]);
    assert.equal(result.restartControlRequired, true);
});

test("config batch preflight failure leaves every requested scope unchanged", async () => {
    let config = createConfig();
    const writes: ControlConfig[] = [];
    const registry = new InstanceRegistryFactory().build(config);
    const occupied = createServer();
    await new Promise<void>((resolve) =>
        occupied.listen(0, "127.0.0.1", resolve),
    );
    const address = occupied.address();
    assert.ok(typeof address === "object" && address !== null);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(nextConfig);
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    try {
        await assert.rejects(
            service.updateConfig({
                instance: {
                    instanceName: "demo-local",
                    patch: {
                        approvalPolicy: { mode: "ask" },
                        security: { mode: "workspace" },
                    },
                },
                web: {
                    enabled: true,
                    listenHost: "127.0.0.1",
                    listenPort: address.port,
                },
            }),
            /Cannot bind HTTP listener 127\.0\.0\.1:/u,
        );
        assert.equal(writes.length, 0);
        assert.equal(config.instances[0]?.security.mode, "disabled");
        assert.equal(config.instances[0]?.approvalPolicy, undefined);
        assert.equal(config.web.enabled, false);
        assert.equal(
            registry.get("demo-local")?.worker.snapshot().effectiveSecurityMode,
            "disabled",
        );
    } finally {
        await new Promise<void>((resolve, reject) =>
            occupied.close((error) =>
                error === undefined ? resolve() : reject(error),
            ),
        );
    }
});

test("config view and validation mask all tokens while updates preserve masked secrets", async () => {
    const strongToken = "a".repeat(48);
    const instanceToken = "instance-" + "b".repeat(48);
    let config = createConfig();
    config.web.auth = { mode: "token", token: strongToken };
    config.instances[0]!.mcp.auth = { mode: "token", token: instanceToken };
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: new InstanceRegistryFactory().build(config),
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    const view = service.getConfigView() as {
        instances: Array<Record<string, unknown>>;
        web: { auth: string; token?: string };
    };
    assert.equal(view.web.auth, "token");
    assert.equal(view.web.token, MASKED_CONFIG_TOKEN);
    assert.ok(!JSON.stringify(view).includes(strongToken));
    assert.equal(
        (view.instances[0]?.mcp as { token?: string }).token,
        MASKED_CONFIG_TOKEN,
    );
    assert.ok(!JSON.stringify(view).includes(instanceToken));

    const draft = {
        ...view,
        instances: view.instances.map((instance) => ({
            ...instance,
            security: { mode: (instance.security as { mode: string }).mode },
        })),
    };
    const validated = service.validateConfigDraft(
        draft as unknown as JsonValue,
    ) as { web: { token?: string } };
    assert.equal(validated.web.token, MASKED_CONFIG_TOKEN);
    assert.ok(!JSON.stringify(validated).includes(strongToken));
    assert.ok(!JSON.stringify(validated).includes(instanceToken));

    await service.updateInstanceConfig({
        instanceName: config.instances[0]!.name,
        patch: { mcp: { auth: "token", token: MASKED_CONFIG_TOKEN } },
    });
    assert.deepEqual(config.instances[0]!.mcp.auth, {
        mode: "token",
        token: instanceToken,
    });

    await service.updateWebConfig({
        patch: { auth: "token", token: MASKED_CONFIG_TOKEN },
    });
    assert.deepEqual(config.web.auth, { mode: "token", token: strongToken });

    await service.updateWebConfig({
        patch: { auth: "token", token: "b".repeat(48) },
    });
    assert.deepEqual(config.web.auth, { mode: "token", token: "b".repeat(48) });
});

test("listener preflight rejects an occupied Web bind without persisting configuration", async () => {
    let config = createConfig();
    const writes: ControlConfig[] = [];
    const occupied = createServer();
    await new Promise<void>((resolve) =>
        occupied.listen(0, "127.0.0.1", resolve),
    );
    const address = occupied.address();
    assert.ok(typeof address === "object" && address !== null);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(nextConfig);
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: new InstanceRegistryFactory().build(config),
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    try {
        await assert.rejects(
            service.updateWebConfig({
                patch: {
                    enabled: true,
                    listenHost: "127.0.0.1",
                    listenPort: address.port,
                },
            }),
            /Cannot bind HTTP listener 127\.0\.0\.1:/u,
        );
        assert.equal(writes.length, 0);
        assert.equal(config.web.listenPort, 17890);
    } finally {
        await new Promise<void>((resolve, reject) =>
            occupied.close((error) =>
                error === undefined ? resolve() : reject(error),
            ),
        );
    }
});

test("listener preflight does not treat a disabled MCP endpoint as active", async () => {
    let config = createConfig();
    config.mcp.enabled = false;
    const occupied = createServer();
    await new Promise<void>((resolve) =>
        occupied.listen(0, "127.0.0.1", resolve),
    );
    const address = occupied.address();
    assert.ok(typeof address === "object" && address !== null);
    config.mcp.listenPort = address.port;
    config.web.listenPort = address.port;
    const service = new ConfigEditorCoordinator({
        configStore: { async write() {} },
        getConfig: () => config,
        instanceRegistry: new InstanceRegistryFactory().build(config),
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    try {
        await assert.rejects(
            service.updateWebConfig({ patch: { enabled: true } }),
            /Cannot bind HTTP listener 127\.0\.0\.1:/u,
        );
        assert.equal(config.web.enabled, false);
    } finally {
        await new Promise<void>((resolve, reject) =>
            occupied.close((error) =>
                error === undefined ? resolve() : reject(error),
            ),
        );
    }
});

test("endpoint runtime failure restores the prior persisted configuration", async () => {
    let config = createConfig();
    const writes: ControlConfig[] = [];
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(nextConfig);
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: new InstanceRegistryFactory().build(config),
        runtimePreflight: { async assertAvailable() {} },
        runtimeApply: {
            async apply() {
                throw new Error("new listener did not become healthy");
            },
        },
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    await assert.rejects(
        service.updateWebConfig({
            patch: { enabled: true, listenPort: 17891 },
        }),
        /new listener did not become healthy/u,
    );
    assert.equal(writes.length, 2);
    assert.equal(writes[0]?.web.listenPort, 17891);
    assert.equal(writes[1]?.web.listenPort, 17890);
    assert.equal(config.web.listenPort, 17890);
});

test("namespace auth updates apply runtime protection before exposing OAuth", async () => {
    let config = createConfig();
    let applyCalls = 0;
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: new InstanceRegistryFactory().build(config),
        runtimeApply: {
            async apply() {
                applyCalls += 1;
                return true;
            },
        },
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: {
            mcp: {
                auth: "oauth2",
                oauth2: { requiredScopes: ["mcp"], resourceName: "demo-local" },
            },
        },
    });
    assert.equal(applyCalls, 1);
});

test("config editor reconfigures and disables a running instance without replacing it", async () => {
    let config = createConfig();
    const reconfigureCalls: Array<Record<string, unknown>> = [];
    let stopCalls = 0;
    const registry = new InstanceRegistry([
        descriptor({
            reconfigure(input: Record<string, unknown>) {
                reconfigureCalls.push(input);
            },
            snapshot: runningSnapshot,
            async stop() {
                stopCalls += 1;
                return {
                    ...runningSnapshot(),
                    daemonState: "stopped",
                    ready: false,
                    status: "stopped",
                };
            },
        }),
    ]);
    const service = createService(
        () => config,
        (next) => {
            config = next;
        },
        registry,
    );

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: {
            alerts: { intervalMs: 2_000, maxUncommittedChanges: 5 },
            approvalPolicy: { mode: "ask" },
        },
    });
    const enabledChanges: boolean[] = [];
    registry.onChange(() => {
        enabledChanges.push(registry.get("demo-local")?.enabled === true);
    });
    await service.disableInstance({ instanceName: "demo-local" });

    assert.equal(config.instances[0]?.enabled, false);
    assert.equal(stopCalls, 1);
    assert.equal(config.instances[0]?.security.mode, "disabled");
    assert.equal(reconfigureCalls.length, 1);
    const reconfigure = reconfigureCalls[0] as {
        alerts?: { intervalMs?: number; maxUncommittedChanges?: number };
        approvalPolicy?: { mode?: string };
        effectiveSecurityMode?: string;
        env?: Record<string, string>;
    };
    assert.equal(reconfigure.alerts?.intervalMs, 2_000);
    assert.equal(reconfigure.alerts?.maxUncommittedChanges, 5);
    assert.equal(reconfigure.approvalPolicy?.mode, "ask");
    assert.equal(reconfigure.effectiveSecurityMode, "disabled");
    assert.equal(
        reconfigure.env?.DEVSHELL_WORKER_INTERNAL_SECURITY_MODE,
        "disabled",
    );
    assert.equal(reconfigure.env?.DEVSHELL_WORKER_SECURITY_MODE, "disabled");
    assert.equal(registry.get("demo-local"), undefined);
    assert.deepEqual(enabledChanges, [false]);

    await service.enableInstance({ instanceName: "demo-local" });
    assert.equal(registry.get("demo-local")?.enabled, true);
    assert.deepEqual(enabledChanges, [false, true]);
});

test("generic enabled=false config patch stops the worker and cancels unresolved Workspace waits", async () => {
    let config = createConfig();
    let stopCalls = 0;
    const cancelledWaits: string[] = [];
    const waits = [
        { status: "waiting", waitId: "wait-question" },
        { status: "detached", waitId: "wait-tmux" },
        { status: "resolved", waitId: "wait-result" },
    ];
    const worker = {
        reconfigure() {},
        snapshot: runningSnapshot,
        async stop() {
            stopCalls += 1;
            return {
                ...runningSnapshot(),
                daemonState: "stopped",
                ready: false,
                status: "stopped",
            };
        },
    };
    const registry = new InstanceRegistry([
        descriptor(worker, {
            wait: {
                async cancel(waitId: string) {
                    cancelledWaits.push(waitId);
                    const wait = waits.find(
                        (entry) => entry.waitId === waitId,
                    )!;
                    wait.status = "cancelled";
                    return wait;
                },
                async get(waitId: string) {
                    return waits.find((entry) => entry.waitId === waitId);
                },
                async list() {
                    return waits;
                },
            },
        }),
    ]);
    const service = createService(
        () => config,
        (next) => {
            config = next;
        },
        registry,
    );

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: { enabled: false },
    });

    assert.equal(stopCalls, 1);
    assert.deepEqual(cancelledWaits, ["wait-question", "wait-tmux"]);
    assert.equal(
        waits.find((entry) => entry.waitId === "wait-result")?.status,
        "resolved",
    );
    assert.equal(config.instances[0]?.enabled, false);
    assert.equal(registry.get("demo-local"), undefined);
});

test("failed managed-instance stop does not roll back a committed disable", async () => {
    let config = createConfig();
    const writes: ControlConfig[] = [];
    const registry = new InstanceRegistry([
        descriptor({
            snapshot: runningSnapshot,
            async stop() {
                throw new Error("worker stop failed");
            },
        }),
    ]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(nextConfig);
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    const warnings = await captureWarnings(
        async () =>
            await service.disableInstance({ instanceName: "demo-local" }),
    );
    assert.equal(writes.length, 1);
    assert.equal(config.instances[0]?.enabled, false);
    assert.equal(registry.get("demo-local"), undefined);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]), /cleanup was incomplete/u);
});

test("instance cleanup debt survives coordinator restart and gates the next generation", async () => {
    const root = await createTestTempDirectory("instance-cleanup-debt");
    const cleanupDebtFile = join(root, "lifecycle-cleanup.json");
    let config = createConfig();
    const firstRegistry = new InstanceRegistry([
        descriptor({
            snapshot: runningSnapshot,
            async stop() {
                return stoppedSnapshot();
            },
        }),
    ]);
    const mapper = {
        map() {
            return descriptor({
                snapshot: stoppedSnapshot,
                async retireRuntime() {},
            });
        },
    } as never;
    const first = new ConfigEditorCoordinator({
        cleanupDebtFile,
        configStore: {
            async write(nextConfig: ControlConfig) {
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceConfigMapper: mapper,
        instanceRegistry: firstRegistry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });
    first.registerInstanceGenerationRetirement(async () => {
        throw new Error("terminal retirement failed");
    });

    const warnings = await captureWarnings(
        async () =>
            await first.disableInstance({ instanceName: "demo-local" }),
    );

    assert.equal(config.instances[0]?.enabled, false);
    assert.equal(firstRegistry.get("demo-local"), undefined);
    assert.equal(warnings.length, 1);

    const secondRegistry = new InstanceRegistry([]);
    const second = new ConfigEditorCoordinator({
        cleanupDebtFile,
        configStore: {
            async write(nextConfig: ControlConfig) {
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceConfigMapper: mapper,
        instanceRegistry: secondRegistry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });
    let replayedGenerationRetirement = 0;
    second.registerInstanceGenerationRetirement(async () => {
        replayedGenerationRetirement += 1;
    });

    await second.reconcileCleanupDebt();
    await second.reconcileCleanupDebt();
    assert.equal(replayedGenerationRetirement, 1);

    await second.enableInstance({ instanceName: "demo-local" });
    assert.equal(config.instances[0]?.enabled, true);
    assert.notEqual(secondRegistry.get("demo-local"), undefined);
});

test("failed cleanup debt persistence does not leave a phantom in-memory debt", async () => {
    const root = await createTestTempDirectory("instance-cleanup-debt-write-failure");
    const cleanupDebtFile = join(root, "lifecycle-cleanup.json");
    await writeFile(cleanupDebtFile, "[]\n", "utf8");
    let config = createConfig();
    const registry = new InstanceRegistry([
        descriptor({ snapshot: stoppedSnapshot }),
    ]);
    const mapper = {
        map() {
            return descriptor({ snapshot: stoppedSnapshot });
        },
    } as never;
    const service = new ConfigEditorCoordinator({
        cleanupDebtFile,
        configStore: {
            async write(nextConfig: ControlConfig) {
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceConfigMapper: mapper,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });
    let generationRetirements = 0;
    service.registerInstanceGenerationRetirement(async () => {
        generationRetirements += 1;
    });
    await service.reconcileCleanupDebt();
    await rm(cleanupDebtFile);
    await mkdir(cleanupDebtFile);

    const warnings = await captureWarnings(
        async () =>
            await service.disableInstance({ instanceName: "demo-local" }),
    );
    assert.equal(warnings.length, 1);
    assert.equal(generationRetirements, 1);

    await service.enableInstance({ instanceName: "demo-local" });
    assert.equal(generationRetirements, 1);
    assert.equal(config.instances[0]?.enabled, true);
});

test("invalid cleanup debt remains fail-closed on repeated reads", async () => {
    const root = await createTestTempDirectory("instance-cleanup-debt-invalid");
    const cleanupDebtFile = join(root, "lifecycle-cleanup.json");
    await writeFile(cleanupDebtFile, "{invalid", "utf8");
    let config = createConfig();
    const service = new ConfigEditorCoordinator({
        cleanupDebtFile,
        configStore: {
            async write(nextConfig: ControlConfig) {
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: new InstanceRegistry([]),
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    await assert.rejects(service.reconcileCleanupDebt(), SyntaxError);
    await assert.rejects(service.reconcileCleanupDebt(), SyntaxError);
});

test("every disable entrypoint commits before cleanup and runs committed lifecycle once", async (t) => {
    const entrypoints: Array<{
        name: string;
        run(service: ConfigEditorCoordinator): Promise<unknown>;
    }> = [
        {
            name: "disableInstance",
            run: async (service) =>
                await service.disableInstance({ instanceName: "demo-local" }),
        },
        {
            name: "updateInstanceConfig",
            run: async (service) =>
                await service.updateInstanceConfig({
                    instanceName: "demo-local",
                    patch: { enabled: false },
                }),
        },
        {
            name: "updateConfig",
            run: async (service) =>
                await service.updateConfig({
                    instance: {
                        instanceName: "demo-local",
                        patch: { enabled: false },
                    },
                }),
        },
    ];

    for (const entrypoint of entrypoints) {
        await t.test(entrypoint.name, async () => {
            let config = createConfig();
            const writes: ControlConfig[] = [];
            let stopCalls = 0;
            let startCalls = 0;
            let committed = 0;
            const waiting = {
                status: "waiting",
                waitId: "wait-retirement-failure",
            };
            const registry = new InstanceRegistry([
                descriptor(
                    {
                        snapshot: runningSnapshot,
                        async stop() {
                            stopCalls += 1;
                            return {
                                ...runningSnapshot(),
                                daemonState: "stopped",
                                ready: false,
                                status: "stopped",
                            };
                        },
                        async start() {
                            startCalls += 1;
                            return runningSnapshot();
                        },
                    },
                    {
                        wait: {
                            async cancel() {
                                throw new Error("wait retirement failed");
                            },
                            async get() {
                                return waiting;
                            },
                            async list() {
                                return [waiting];
                            },
                        },
                    },
                ),
            ]);
            const service = new ConfigEditorCoordinator({
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        writes.push(nextConfig);
                        config = nextConfig;
                    },
                },
                getConfig: () => config,
                instanceRegistry: registry,
                setConfig: (nextConfig) => {
                    config = nextConfig;
                },
            });
            service.registerInstanceDisabled(async () => {
                committed += 1;
            });

            const warnings = await captureWarnings(
                async () => await entrypoint.run(service),
            );
            assert.equal(stopCalls, 1);
            assert.equal(startCalls, 0);
            assert.equal(committed, 1);
            assert.equal(writes.length, 1);
            assert.equal(config.instances[0]?.enabled, false);
            assert.equal(registry.get("demo-local"), undefined);
            assert.equal(warnings.length, 1);
        });
    }
});

test("disable commits before stopping the Worker and retiring interactions", async () => {
    let config = createConfig();
    const actions: string[] = [];
    const registry = new InstanceRegistry([
        descriptor({
            snapshot: runningSnapshot,
            async stop() {
                actions.push("worker.stop");
                return {
                    ...runningSnapshot(),
                    daemonState: "stopped",
                    ready: false,
                    status: "stopped",
                };
            },
        }),
    ]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                actions.push("config.write");
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });
    service.registerInstanceDisableRetirement(async (instance) => {
        actions.push(`interaction.retire:${instance.name}`);
    });

    await service.disableInstance({ instanceName: "demo-local" });

    assert.deepEqual(actions.slice(0, 3), [
        "config.write",
        "worker.stop",
        "interaction.retire:demo-local",
    ]);
    assert.equal(config.instances[0]?.enabled, false);
});

test("disable persistence failure performs no Worker or interaction cleanup", async () => {
    let config = createConfig();
    let stopCalls = 0;
    let startCalls = 0;
    const registry = new InstanceRegistry([
        descriptor({
            snapshot: runningSnapshot,
            async stop() {
                stopCalls += 1;
                return {
                    ...runningSnapshot(),
                    daemonState: "stopped",
                    ready: false,
                    status: "stopped",
                };
            },
            async start() {
                startCalls += 1;
                return runningSnapshot();
            },
        }),
    ]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write() {
                throw new Error("config persistence failed");
            },
        },
        getConfig: () => config,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    await assert.rejects(
        service.disableInstance({ instanceName: "demo-local" }),
        /config persistence failed/u,
    );
    assert.equal(stopCalls, 0);
    assert.equal(startCalls, 0);
    assert.equal(config.instances[0]?.enabled, true);
    assert.equal(registry.get("demo-local")?.enabled, true);
});

test("disable committed listeners do not run when persistence fails", async () => {
    let config = createConfig();
    let committed = 0;
    const registry = new InstanceRegistry([
        descriptor({
            snapshot: runningSnapshot,
            async stop() {
                return {
                    ...runningSnapshot(),
                    daemonState: "stopped",
                    ready: false,
                    status: "stopped",
                };
            },
            async start() {
                return runningSnapshot();
            },
        }),
    ]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write() {
                throw new Error("config persistence failed");
            },
        },
        getConfig: () => config,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });
    service.registerInstanceDisabled(async () => {
        committed += 1;
    });

    await assert.rejects(
        service.disableInstance({ instanceName: "demo-local" }),
        /config persistence failed/u,
    );
    assert.equal(committed, 0);
    assert.equal(config.instances[0]?.enabled, true);
    assert.equal(registry.get("demo-local")?.enabled, true);
});

test("disable committed listeners run after persisted descriptor state is visible", async () => {
    let config = createConfig();
    const observed: string[] = [];
    const registry = new InstanceRegistry([
        descriptor({
            snapshot: runningSnapshot,
            async stop() {
                return {
                    ...runningSnapshot(),
                    daemonState: "stopped",
                    ready: false,
                    status: "stopped",
                };
            },
        }),
    ]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });
    registry.onChange(() => {
        observed.push(`registry:${registry.get("demo-local")?.enabled}`);
    });
    service.registerInstanceDisabled(async () => {
        observed.push(
            `committed:${config.instances[0]?.enabled}:${registry.get("demo-local")?.enabled}`,
        );
    });

    await service.disableInstance({ instanceName: "demo-local" });

    assert.deepEqual(observed, [
        "registry:undefined",
        "committed:false:undefined",
    ]);
});

test("disable committed-listener failure is cleanup degradation, not transaction failure", async () => {
    let config = createConfig();
    const registry = new InstanceRegistry([
        descriptor({ snapshot: stoppedSnapshot }),
    ]);
    const service = createService(
        () => config,
        (next) => {
            config = next;
        },
        registry,
    );
    service.registerInstanceDisabled(async () => {
        throw new Error("comment retirement failed");
    });

    const warnings = await captureWarnings(
        async () => await service.disableInstance({ instanceName: "demo-local" }),
    );

    assert.equal(config.instances[0]?.enabled, false);
    assert.equal(registry.get("demo-local"), undefined);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]), /cleanup was incomplete/u);
});

test("Control disable does not stop self-managed reverse workers but retires local pending interactions", async () => {
    let config = createConfig();
    let stopCalls = 0;
    const cancelledApprovals: string[] = [];
    const cancelledWaits: string[] = [];
    const registry = new InstanceRegistry([
        descriptor(
            {
                managementMode: "selfManaged",
                snapshot: runningSnapshot,
                async listApprovals() {
                    return [
                        {
                            approvalId: "approval-self-managed",
                            status: "pending",
                        },
                    ];
                },
                async cancelApproval(approvalId: string) {
                    cancelledApprovals.push(approvalId);
                    return { approvalId, status: "cancelled" };
                },
                async stop() {
                    stopCalls += 1;
                    throw new Error("must not stop self-managed worker");
                },
            },
            {
                wait: {
                    async cancel(waitId: string) {
                        cancelledWaits.push(waitId);
                        return { status: "cancelled", waitId };
                    },
                    async get() {
                        return undefined;
                    },
                    async list() {
                        return [
                            { status: "waiting", waitId: "wait-self-managed" },
                        ];
                    },
                },
            },
        ),
    ]);
    const service = createService(
        () => config,
        (next) => {
            config = next;
        },
        registry,
    );

    await service.disableInstance({ instanceName: "demo-local" });

    assert.equal(stopCalls, 0);
    assert.deepEqual(cancelledApprovals, ["approval-self-managed"]);
    assert.deepEqual(cancelledWaits, ["wait-self-managed"]);
    assert.equal(config.instances[0]?.enabled, false);
    assert.equal(registry.get("demo-local"), undefined);
});

test("instance reconfigure failure restores persisted and runtime configuration", async () => {
    let config = createConfig();
    const writes: ControlConfig[] = [];
    let runtimeSecurityMode = "disabled";
    let failNext = true;
    const worker = {
        reconfigure(input: { effectiveSecurityMode?: string }) {
            runtimeSecurityMode = input.effectiveSecurityMode ?? "";
            if (failNext) {
                failNext = false;
                throw new Error("worker reconfigure failed");
            }
        },
        snapshot: () => ({
            connectionState: "disconnected",
            daemonState: "stopped",
            lastSeq: 0,
            name: "demo-local",
            ready: false,
            status: "stopped",
        }),
    };
    const registry = new InstanceRegistry([descriptor(worker)]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(structuredClone(nextConfig));
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    await assert.rejects(
        service.updateInstanceConfig({
            instanceName: "demo-local",
            patch: { approvalPolicy: { mode: "ask" } },
        }),
        /worker reconfigure failed/u,
    );

    assert.equal(writes.length, 2);
    assert.equal(config.instances[0]?.security.mode, "disabled");
    assert.equal(config.instances[0]?.approvalPolicy, undefined);
    assert.equal(runtimeSecurityMode, "disabled");
});

test("successful instance rebuild replaces the descriptor then closes the old Worker generation", async () => {
    let config = createConfig();
    const actions: string[] = [];
    const oldDescriptor = descriptor({
        snapshot: stoppedSnapshot,
        async close() {
            actions.push("old.close");
        },
    });
    const replacement = descriptor({ snapshot: stoppedSnapshot });
    const registry = new InstanceRegistry([oldDescriptor]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                actions.push("config.write");
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceConfigMapper: {
            map() {
                actions.push("replacement.prepare");
                return replacement;
            },
        } as never,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: { tools: { scheduler: { maxRunning: 2 } } },
    });

    assert.equal(registry.get("demo-local"), replacement);
    assert.deepEqual(actions, [
        "replacement.prepare",
        "config.write",
        "old.close",
    ]);
});

test("instance rebuild cleanup debt withholds replacement and reconciles before restart admission", async () => {
    const root = await createTestTempDirectory("instance-rebuild-cleanup-debt");
    const cleanupDebtFile = join(root, "lifecycle-cleanup.json");
    let config = createConfig();
    const writes: ControlConfig[] = [];
    const oldDescriptor = descriptor({
        snapshot: stoppedSnapshot,
    });
    let replacementClosed = 0;
    const replacement = descriptor({
        snapshot: stoppedSnapshot,
        async close() {
            replacementClosed += 1;
        },
    });
    const registry = new InstanceRegistry([oldDescriptor]);
    const service = new ConfigEditorCoordinator({
        cleanupDebtFile,
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(structuredClone(nextConfig));
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceConfigMapper: { map: () => replacement } as never,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });
    service.registerInstanceGenerationRetirement(async () => {
        throw new Error("old generation cleanup failed");
    });

    const warnings = await captureWarnings(
        async () =>
            await service.updateInstanceConfig({
                instanceName: "demo-local",
                patch: { tools: { scheduler: { maxRunning: 2 } } },
            }),
    );

    assert.equal(writes.length, 1);
    assert.equal(config.instances[0]?.tools?.scheduler?.maxRunning, 2);
    assert.equal(registry.get("demo-local"), undefined);
    assert.equal(replacementClosed, 1);
    assert.equal(warnings.length, 1);

    const startupDescriptor = descriptor({ snapshot: stoppedSnapshot });
    const restartedRegistry = new InstanceRegistry([startupDescriptor]);
    const restarted = new ConfigEditorCoordinator({
        cleanupDebtFile,
        configStore: {
            async write(nextConfig: ControlConfig) {
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: restartedRegistry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });
    let replayed = 0;
    restarted.registerInstanceGenerationRetirement(async () => {
        replayed += 1;
        assert.equal(restartedRegistry.get("demo-local"), undefined);
    });

    await restarted.reconcileCleanupDebt();
    await restarted.reconcileCleanupDebt();
    assert.equal(replayed, 1);
    assert.equal(restartedRegistry.get("demo-local"), startupDescriptor);
    await rm(root, { force: true, recursive: true });
});

test("failed rebuild persistence closes the uncommitted replacement descriptor", async () => {
    let config = createConfig();
    let replacementClosed = 0;
    const oldDescriptor = descriptor({ snapshot: stoppedSnapshot });
    const replacement = descriptor({
        snapshot: stoppedSnapshot,
        async close() {
            replacementClosed += 1;
        },
    });
    const registry = new InstanceRegistry([oldDescriptor]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write() {
                throw new Error("rebuild persistence failed");
            },
        },
        getConfig: () => config,
        instanceConfigMapper: { map: () => replacement } as never,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    await assert.rejects(
        service.updateInstanceConfig({
            instanceName: "demo-local",
            patch: { tools: { scheduler: { maxRunning: 2 } } },
        }),
        /rebuild persistence failed/u,
    );

    assert.equal(replacementClosed, 1);
    assert.equal(registry.get("demo-local"), oldDescriptor);
    assert.equal(config.instances[0]?.tools, undefined);
});

test("instance delete terminalizes live state and detaches Context environments before descriptor removal", async () => {
    let config = createConfig();
    const actions: string[] = [];
    const waits = [
        { status: "waiting", waitId: "wait-live" },
        { status: "resolved", waitId: "wait-result" },
        { status: "consumed", waitId: "wait-history" },
    ];
    const registry = new InstanceRegistry([
        descriptor(
            {
                snapshot: stoppedSnapshot,
                async listApprovals() {
                    return [{ approvalId: "approval-live", status: "pending" }];
                },
                async cancelApproval(approvalId: string) {
                    actions.push(`approval.cancel:${approvalId}`);
                    return { approvalId, status: "cancelled" };
                },
                async retireRuntime() {
                    actions.push("runtime.retire");
                },
                async retireProviderResources() {
                    actions.push("provider.retire");
                },
                async close() {
                    actions.push("worker.close");
                },
            },
            {
                goal: {
                    async continuation() {
                        return {};
                    },
                    async manage() {
                        return undefined;
                    },
                    async read() {
                        return undefined;
                    },
                    async stopAll() {
                        actions.push("goals.stopAll");
                        return [];
                    },
                    async touch() {},
                },
                todo: {
                    async cancelAll() {
                        actions.push("todos.cancelAll");
                    },
                    async control() {
                        throw new Error("unused");
                    },
                    currentAssociation() {
                        return undefined;
                    },
                    async delete() {},
                    async read() {
                        return {
                            items: [],
                            revision: 0,
                            summary: { completed: 0, total: 0 },
                        };
                    },
                    summaries() {
                        return [];
                    },
                    async write() {
                        throw new Error("unused");
                    },
                },
                wait: {
                    async cancel(waitId: string) {
                        actions.push(`wait.cancel:${waitId}`);
                        const wait = waits.find(
                            (entry) => entry.waitId === waitId,
                        )!;
                        wait.status = "cancelled";
                        return wait;
                    },
                    async consume(waitId: string) {
                        actions.push(`wait.consume:${waitId}`);
                        const wait = waits.find(
                            (entry) => entry.waitId === waitId,
                        )!;
                        wait.status = "consumed";
                        return wait;
                    },
                    async get(waitId: string) {
                        return waits.find((entry) => entry.waitId === waitId);
                    },
                    async list() {
                        return waits;
                    },
                },
            },
        ),
    ]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                config = nextConfig;
            },
        },
        getConfig: () => config,
        getMcpHost: () =>
            ({
                contextAdmin: {
                    async detachInstance(instance: string) {
                        actions.push(`context.detach:${instance}`);
                        return [];
                    },
                },
                unregisterInstance(instance: string) {
                    actions.push(`mcp.unregister:${instance}`);
                },
            }) as never,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    await service.deleteInstance({ instanceName: "demo-local" });

    assert.deepEqual(actions, [
        "mcp.unregister:demo-local",
        "approval.cancel:approval-live",
        "wait.cancel:wait-live",
        "wait.consume:wait-result",
        "goals.stopAll",
        "todos.cancelAll",
        "runtime.retire",
        "provider.retire",
        "worker.close",
        "context.detach:demo-local",
    ]);
    assert.equal(config.instances.length, 0);
    assert.equal(registry.get("demo-local"), undefined);
});

test("instance delete preserves wait cleanup and readback failures", async () => {
    let config = createConfig();
    const waiting = { status: "waiting", waitId: "wait-readback" };
    const registry = new InstanceRegistry([
        descriptor(
            { snapshot: stoppedSnapshot },
            {
                wait: {
                    async cancel() {
                        throw new Error("wait cancel failed");
                    },
                    async consume() {
                        throw new Error("unused");
                    },
                    async get() {
                        throw new Error("wait readback failed");
                    },
                    async list() {
                        return [waiting];
                    },
                },
            },
        ),
    ]);
    const service = createService(
        () => config,
        (next) => {
            config = next;
        },
        registry,
    );

    const warnings = await captureWarnings(
        async () =>
            await service.deleteInstance({ instanceName: "demo-local" }),
    );

    assert.equal(warnings.length, 1);
    const outer = warnings[0];
    assert.ok(outer instanceof AggregateError);
    const inner = outer.errors[0];
    assert.ok(inner instanceof AggregateError);
    assert.deepEqual(
        inner.errors.map((entry) => (entry as Error).message),
        ["wait cancel failed", "wait readback failed"],
    );
});

test("instance delete does not treat a still-resolved wait as consumed", async () => {
    let config = createConfig();
    const resolved = { status: "resolved", waitId: "wait-result" };
    const registry = new InstanceRegistry([
        descriptor(
            { snapshot: stoppedSnapshot },
            {
                wait: {
                    async cancel() {
                        throw new Error("unused");
                    },
                    async consume() {
                        throw new Error("wait consume failed");
                    },
                    async get() {
                        return resolved;
                    },
                    async list() {
                        return [resolved];
                    },
                },
            },
        ),
    ]);
    const service = createService(
        () => config,
        (next) => {
            config = next;
        },
        registry,
    );

    const warnings = await captureWarnings(
        async () =>
            await service.deleteInstance({ instanceName: "demo-local" }),
    );

    assert.equal(warnings.length, 1);
    const outer = warnings[0];
    assert.ok(outer instanceof AggregateError);
    const inner = outer.errors[0];
    assert.ok(inner instanceof AggregateError);
    assert.deepEqual(
        inner.errors.map((entry) => (entry as Error).message),
        ["wait consume failed"],
    );
});

test("instance delete commits configuration before generation retirement", async () => {
    let config = createConfig();
    const actions: string[] = [];
    const registry = new InstanceRegistry([
        descriptor(
            { snapshot: stoppedSnapshot },
            {
                goal: {
                    async continuation() {
                        return {};
                    },
                    async manage() {
                        return undefined;
                    },
                    async read() {
                        return undefined;
                    },
                    async stopAll() {
                        return [];
                    },
                    async touch() {},
                },
                todo: {
                    async cancelAll() {},
                    async control() {
                        throw new Error("unused");
                    },
                    currentAssociation() {
                        return undefined;
                    },
                    async delete() {},
                    async read() {
                        return {
                            items: [],
                            revision: 0,
                            summary: { completed: 0, total: 0 },
                        };
                    },
                    summaries() {
                        return [];
                    },
                    async write() {
                        throw new Error("unused");
                    },
                },
            },
        ),
    ]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                actions.push(`config.write:${nextConfig.instances.length}`);
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });
    service.registerInstanceDeleteRetirement(async (instance) => {
        actions.push(`generation.retire:${instance.name}`);
    });

    await service.deleteInstance({ instanceName: "demo-local" });

    assert.deepEqual(actions, [
        "config.write:0",
        "generation.retire:demo-local",
    ]);
});

test("instance delete remains committed when generation retirement fails", async () => {
    let config = createConfig();
    const writes: number[] = [];
    const registry = new InstanceRegistry([
        descriptor({ snapshot: stoppedSnapshot }),
    ]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(nextConfig.instances.length);
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });
    service.registerInstanceDeleteRetirement(async () => {
        throw new Error("generation retirement failed");
    });

    const warnings = await captureWarnings(
        async () => await service.deleteInstance({ instanceName: "demo-local" }),
    );
    assert.deepEqual(writes, [0]);
    assert.equal(config.instances.length, 0);
    assert.equal(registry.get("demo-local"), undefined);
    assert.equal(warnings.length, 1);
});

test("instance delete remains committed when live-state retirement fails", async () => {
    let config = createConfig();
    const writes: number[] = [];
    const registry = new InstanceRegistry([
        descriptor(
            {
                snapshot: stoppedSnapshot,
            },
            {
                goal: {
                    async continuation() {
                        return {};
                    },
                    async manage() {
                        return undefined;
                    },
                    async read() {
                        return undefined;
                    },
                    async stopAll() {
                        throw new Error("goal retirement failed");
                    },
                    async touch() {},
                },
            },
        ),
    ]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(nextConfig.instances.length);
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    const warnings = await captureWarnings(
        async () => await service.deleteInstance({ instanceName: "demo-local" }),
    );
    assert.deepEqual(writes, [0]);
    assert.equal(config.instances.length, 0);
    assert.equal(registry.get("demo-local"), undefined);
    assert.equal(warnings.length, 1);
});

test("instance delete committed-listener failure does not reverse the delete", async () => {
    let config = createConfig();
    const registry = new InstanceRegistry([
        descriptor({ snapshot: stoppedSnapshot }),
    ]);
    const service = createService(
        () => config,
        (next) => {
            config = next;
        },
        registry,
    );
    service.registerInstanceDeleted(async () => {
        throw new Error("comment delete cleanup failed");
    });

    const warnings = await captureWarnings(
        async () => await service.deleteInstance({ instanceName: "demo-local" }),
    );

    assert.equal(config.instances.length, 0);
    assert.equal(registry.get("demo-local"), undefined);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]), /cleanup was incomplete/u);
});

test("instance delete persistence failure performs no destructive cleanup", async () => {
    let config = createConfig();
    const actions: string[] = [];
    const registry = new InstanceRegistry([
        descriptor(
            {
                snapshot: stoppedSnapshot,
            },
            {
                goal: {
                    async continuation() {
                        return {};
                    },
                    async manage() {
                        return undefined;
                    },
                    async read() {
                        return undefined;
                    },
                    async stopAll() {
                        actions.push("goals.stopAll");
                        return [];
                    },
                    async touch() {},
                },
                todo: {
                    async cancelAll() {
                        actions.push("todos.cancelAll");
                    },
                    async control() {
                        throw new Error("unused");
                    },
                    currentAssociation() {
                        return undefined;
                    },
                    async delete() {},
                    async read() {
                        return {
                            items: [],
                            revision: 0,
                            summary: { completed: 0, total: 0 },
                        };
                    },
                    summaries() {
                        return [];
                    },
                    async write() {
                        throw new Error("unused");
                    },
                },
            },
        ),
    ]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write() {
                throw new Error("delete persistence failed");
            },
        },
        getConfig: () => config,
        getMcpHost: () =>
            ({
                contextAdmin: {
                    async detachInstance(instance: string) {
                        actions.push(`context.detach:${instance}`);
                        return [];
                    },
                },
            }) as never,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });
    service.registerInstanceDeleted(async () => {
        actions.push("committed.delete");
    });

    await assert.rejects(
        service.deleteInstance({ instanceName: "demo-local" }),
        /delete persistence failed/u,
    );
    assert.deepEqual(actions, []);
    assert.equal(config.instances.length, 1);
    assert.notEqual(registry.get("demo-local"), undefined);
});

test("instance delete permits failed and stale instances without requiring a provider stop", async () => {
    for (const daemonState of ["failed", "stale"] as const) {
        let config = createConfig();
        const workerRetirements: string[] = [];
        const registry = new InstanceRegistry([
            descriptor(
                {
                    async retireProviderResources() {
                        workerRetirements.push("provider");
                        throw new Error("provider cleanup unavailable");
                    },
                    async retireRuntime() {
                        workerRetirements.push("runtime");
                        throw new Error(
                            "runtime cleanup must not require a degraded provider",
                        );
                    },
                    snapshot: () => ({
                        ...stoppedSnapshot(),
                        connectionState:
                            daemonState === "failed"
                                ? "failed"
                                : "disconnected",
                        daemonState,
                        status: daemonState,
                    }),
                },
                {
                    goal: {
                        async continuation() {
                            return {};
                        },
                        async manage() {
                            return undefined;
                        },
                        async read() {
                            return undefined;
                        },
                        async stopAll() {
                            return [];
                        },
                        async touch() {},
                    },
                    todo: {
                        async cancelAll() {},
                        async control() {
                            throw new Error("unused");
                        },
                        currentAssociation() {
                            return undefined;
                        },
                        async delete() {},
                        async read() {
                            return {
                                items: [],
                                revision: 0,
                                summary: { completed: 0, total: 0 },
                            };
                        },
                        summaries() {
                            return [];
                        },
                        async write() {
                            throw new Error("unused");
                        },
                    },
                },
            ),
        ]);
        const service = createService(
            () => config,
            (next) => {
                config = next;
            },
            registry,
        );

        await service.deleteInstance({ instanceName: "demo-local" });

        assert.equal(
            config.instances.length,
            0,
            `${daemonState} config should be deleted`,
        );
        assert.equal(
            registry.get("demo-local"),
            undefined,
            `${daemonState} descriptor should be removed`,
        );
        assert.deepEqual(
            workerRetirements,
            ["provider"],
            `${daemonState} should skip runtime cleanup and tolerate provider cleanup failure`,
        );
    }
});

test("instance delete permits a stopped instance when runtime and provider cleanup are unreachable", async () => {
    let config = createConfig();
    const workerRetirements: string[] = [];
    const registry = new InstanceRegistry([
        descriptor(
            {
                async retireProviderResources() {
                    workerRetirements.push("provider");
                    throw new Error("provider cleanup unavailable");
                },
                async retireRuntime() {
                    workerRetirements.push("runtime");
                    throw new Error(
                        "Worker target probe failed for provider ssh.",
                    );
                },
                snapshot: stoppedSnapshot,
            },
            {
                goal: {
                    async continuation() {
                        return {};
                    },
                    async manage() {
                        return undefined;
                    },
                    async read() {
                        return undefined;
                    },
                    async stopAll() {
                        return [];
                    },
                    async touch() {},
                },
                todo: {
                    async cancelAll() {},
                    async control() {
                        throw new Error("unused");
                    },
                    currentAssociation() {
                        return undefined;
                    },
                    async delete() {},
                    async read() {
                        return {
                            items: [],
                            revision: 0,
                            summary: { completed: 0, total: 0 },
                        };
                    },
                    summaries() {
                        return [];
                    },
                    async write() {
                        throw new Error("unused");
                    },
                },
            },
        ),
    ]);
    const service = createService(
        () => config,
        (next) => {
            config = next;
        },
        registry,
    );

    await service.deleteInstance({ instanceName: "demo-local" });

    assert.equal(config.instances.length, 0);
    assert.equal(registry.get("demo-local"), undefined);
    assert.deepEqual(workerRetirements, ["runtime", "provider"]);
});

test("config editor rejects delete and rebuild patches while an instance is running before persistence", async () => {
    let config = createConfig();
    const writes: unknown[] = [];
    const registry = new InstanceRegistry([
        descriptor({ snapshot: runningSnapshot }),
    ]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(nextConfig);
                config = nextConfig;
            },
        },
        getConfig: () => config,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    await assert.rejects(
        service.deleteInstance({ instanceName: "demo-local" }),
        hasCode("instance.conflict"),
    );
    await assert.rejects(
        service.updateInstanceConfig({
            instanceName: "demo-local",
            patch: { tools: { scheduler: { maxRunning: 2 } } },
        }),
        hasCode("instance.conflict"),
    );
    await assert.rejects(
        service.updateInstanceConfig({
            instanceName: "demo-local",
            patch: { security: { mode: "workspace" } },
        }),
        hasCode("instance.conflict"),
    );
    assert.equal(writes.length, 0);
    assert.equal(config.instances[0]?.tools, undefined);
    assert.equal(config.instances[0]?.security.mode, "disabled");
});

test("config editor hot-applies model Extension ACL and MCP context changes without restarting control", async () => {
    let config = createConfig();
    const registry = new InstanceRegistry([
        descriptor(
            {
                async reconfigure() {},
                snapshot: stoppedSnapshot,
            },
            {
                goal: {
                    async continuation() {
                        return {};
                    },
                    async manage() {
                        return undefined;
                    },
                    async read() {
                        return undefined;
                    },
                    async stopAll() {
                        return [];
                    },
                    async touch() {},
                },
                mcpContextMode: "explicit",
                modelExtensions: ["instance"],
                todo: {
                    async cancelAll() {},
                    async control() {
                        throw new Error("unused");
                    },
                    currentAssociation() {
                        return undefined;
                    },
                    async delete() {},
                    async read() {
                        return {
                            items: [],
                            revision: 0,
                            summary: { completed: 0, total: 0 },
                        };
                    },
                    summaries() {
                        return [];
                    },
                    async write() {
                        throw new Error("unused");
                    },
                },
            },
        ),
    ]);
    const registered: Array<Record<string, unknown>> = [];
    const retiredWorkspaceApps: string[] = [];
    const unregistered: string[] = [];
    const gateway = {} as never;
    const host = {
        contextAdmin: {
            async detachInstance() {
                return [];
            },
        },
        registerInstance(instance: Record<string, unknown>) {
            registered.push(instance);
        },
        async retireWorkspaceApp(instanceName: string) {
            retiredWorkspaceApps.push(instanceName);
        },
        unregisterInstance(instanceName: string) {
            unregistered.push(instanceName);
        },
    };
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                config = nextConfig;
            },
        },
        getConfig: () => config,
        getMcpHost: () => host as never,
        getMcpInstanceGateway: () => gateway,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: {
            extensions: { model: ["instance", "artifact"] },
        },
    });

    assert.equal(registered.length, 1);
    assert.deepEqual(retiredWorkspaceApps, []);
    assert.equal(registered[0]?.gateway, gateway);
    assert.equal("policy" in registered[0]!, false);
    assert.deepEqual(registered[0]?.auth, { enabled: false, provider: "none" });
    assert.equal(registered[0]?.contextMode, "explicit");
    assert.deepEqual(registry.get("demo-local")?.modelExtensions, [
        "instance",
        "artifact",
    ]);

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: { mcp: { contextMode: "openai-session" } },
    });
    assert.equal(registered[1]?.contextMode, "openai-session");
    assert.equal(registered[1]?.workspaceEnabled, true);
    assert.equal(registry.get("demo-local")?.mcpContextMode, "openai-session");

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: { workspace: { enabled: false } },
    });
    assert.deepEqual(retiredWorkspaceApps, ["demo-local"]);
    assert.equal(registered[2]?.workspaceEnabled, false);
    assert.equal(config.instances[0]?.workspace.enabled, false);

    const authUpdate = (await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: {
            mcp: {
                auth: "token",
                contextMode: "explicit",
                token: "0123456789abcdef0123456789abcdef",
            },
        },
    })) as { appliedChanges: Array<{ kind: string; target: string }> };
    assert.equal(registered[3]?.contextMode, "explicit");
    assert.deepEqual(registered[3]?.auth, {
        enabled: true,
        provider: "token",
        token: "0123456789abcdef0123456789abcdef",
    });
    assert.deepEqual(authUpdate.appliedChanges, [
        { kind: "instance.updated", target: "demo-local" },
    ]);

    await service.disableInstance({ instanceName: "demo-local" });
    assert.deepEqual(unregistered, ["demo-local"]);
    assert.deepEqual(retiredWorkspaceApps, ["demo-local", "demo-local"]);
    await service.enableInstance({ instanceName: "demo-local" });
    assert.equal(registered.length, 5);
    assert.equal(registered[4]?.workspaceEnabled, false);
    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: { workspace: { enabled: true } },
    });
    assert.equal(registered.length, 6);
    assert.equal(registered[5]?.workspaceEnabled, true);
    await service.deleteInstance({ instanceName: "demo-local" });
    assert.deepEqual(unregistered, ["demo-local", "demo-local"]);
    assert.equal(registry.get("demo-local"), undefined);
});

function createConfig() {
    const config = createDefaultControlConfig();
    config.mcp.enabled = true;
    config.instances = [
        normalizeConfigInstanceDraft({
            mcp: {
                enabled: true,
            },
            name: "demo-local",
            provider: "local",
            security: { mode: "disabled" },
        }),
    ];
    return config;
}

function createService(
    getConfig: () => ReturnType<typeof createConfig>,
    setConfig: (config: ReturnType<typeof createConfig>) => void,
    registry: InstanceRegistry,
): ConfigEditorCoordinator {
    return new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                setConfig(nextConfig);
            },
        },
        getConfig,
        instanceRegistry: registry,
        setConfig,
    });
}

function descriptor(
    worker: Record<string, unknown>,
    extra: Record<string, unknown> = {},
) {
    return {
        enabled: true,
        goal: {
            async continuation() {
                return {};
            },
            async list() {
                return [];
            },
            async manage() {
                return undefined;
            },
            async read() {
                return undefined;
            },
            async recordReentry() {},
            async stopAll() {
                return [];
            },
            async touch() {},
        },
        mcpEnabled: true,
        mcpPath: "/demo-local/mcp",
        modelExtensions: ["instance"],
        name: "demo-local",
        todo: {
            async cancelAll() {},
            async control() {
                throw new Error("unused");
            },
            currentAssociation() {
                return undefined;
            },
            async delete() {},
            async read() {
                return {
                    items: [],
                    revision: 0,
                    summary: { completed: 0, total: 0 },
                };
            },
            summaries() {
                return [];
            },
            async write() {
                throw new Error("unused");
            },
        },
        worker: {
            managementMode: "controllerManaged",
            async listApprovals() {
                return [];
            },
            async cancelApproval() {
                throw new Error("no pending approval");
            },
            async retireRuntime() {},
            async retireProviderResources() {},
            ...worker,
        },
        ...extra,
    } as never;
}

function stoppedSnapshot() {
    return {
        connectionState: "disconnected",
        daemonState: "stopped",
        effectiveSecurityMode: "disabled",
        lastSeq: 0,
        name: "demo-local",
        ready: false,
        status: "stopped",
    };
}

function runningSnapshot() {
    return {
        connectionState: "connected",
        daemonState: "running",
        effectiveSecurityMode: "disabled",
        lastSeq: 0,
        name: "demo-local",
        ready: true,
        status: "ready",
    };
}

async function captureWarnings(operation: () => Promise<unknown>): Promise<unknown[]> {
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (value?: unknown) => {
        warnings.push(value);
    };
    try {
        await operation();
    } finally {
        console.warn = originalWarn;
    }
    return warnings;
}

function hasCode(code: string): (error: unknown) => boolean {
    return (error) => {
        assert.equal((error as { code?: string }).code, code);
        return true;
    };
}

function emptyApplyResult() {
    return {
        affectedInstances: [],
        affectedMcpEndpoints: [],
        appliedChanges: [],
        reloadRequired: false,
        restartControlRequired: false,
    };
}
