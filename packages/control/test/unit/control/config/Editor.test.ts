import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { ConfigEditorCoordinator } from "../../../../src/config/editor/index.ts";
import { ConfigEngine } from "../../../../src/config/engine/index.ts";
import type {
    ConfigEngineOptions,
    ConfigRuntimeChangeSet,
} from "../../../../src/config/engine/Api.ts";
import { HttpEndpointPreflight } from "../../../../src/config/engine/Http.ts";
import {
    InstanceEditorCoordinator as ProductionInstanceEditorCoordinator,
    type InstanceEditorCoordinatorOptions,
} from "../../../../src/instance/editor/index.ts";
import { InstanceChangeHub } from "../../../../src/instance/Change.ts";
import { Instance } from "@portable-devshell/core/instance";
import { InstanceRegistry } from "../../../../src/instance/Registry.ts";
import { createContextRuntime } from "../../../../src/context/index.ts";
import { createDefaultControlConfig, asInstanceName, type ControlConfig, type EnvironmentTransport, type InstanceProcessEnvelope, type InstanceRuntimeTransport, type ProcessTransport } from "@portable-devshell/shared";
import {
    buildTestInstanceRegistry,
    createTestInstance,
    testRuntimeHooks,
} from "../../../support/InstanceRuntime.ts";
import { ConfigChangeHub } from "../../../../src/config/change/Config.ts";
import {
    MASKED_CONFIG_TOKEN,
    normalizeConfigInstanceDraft,
    type JsonValue,
} from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

const testEnvironmentTransport: EnvironmentTransport = {
    async prepareExtensionResource() {
        throw new Error("Unused test environment transport.");
    },
    async prepareWorkspace(workspace) {
        return {
            projectMemoryAgentFile: `${workspace}/AGENTS.md`,
            projectMemoryDirectory: `${workspace}/.agent`,
            temporaryDirectory: "/tmp/context",
            workspace,
        };
    },
    async readAlerts() {
        return { advice: [] };
    },
    async releaseAlerts() {},
    async touchAlerts() {
        return { advice: [] };
    },
    async touchTemporaryDirectory() {},
};

const testProcessTransport: ProcessTransport = {
    async readLogs() {
        return [];
    },
    async refresh() {
        return testProcessEnvelope();
    },
    async snapshot() {
        return testProcessEnvelope();
    },
    async start() {
        throw new Error("Unused test process transport.");
    },
    async stop() {
        throw new Error("Unused test process transport.");
    },
    async subscribe() {
        throw new Error("Unused test process transport.");
    },
};

const testInstanceRuntimeTransport: InstanceRuntimeTransport = {
    async acquireReference() {
        return {};
    },
    async appendEvent() {},
    async readEvents() {
        throw new Error("Unused test instance runtime.");
    },
    async releaseReference() {},
    async subscribeEvents() {
        throw new Error("Unused test instance runtime.");
    },
};

function testProcessEnvelope(): InstanceProcessEnvelope {
    return {
        lastSeq: 0,
        snapshot: {
            connectionState: "connected",
            daemonState: "running",
            lastSeq: 0,
            name: asInstanceName("local"),
            ready: true,
            status: "ready",
        },
        worker: {
            capabilities: { cancel: true, streaming: true, tools: true },
            platform: { arch: "x86_64", os: "linux" },
            protocolVersion: "1",
            version: "test",
        },
    };
}

class InstanceRegistryFactory {
    build(config: ControlConfig): InstanceRegistry {
        return buildTestInstanceRegistry(config);
    }
}

class InstanceEditorCoordinator extends ProductionInstanceEditorCoordinator {
    readonly changes: InstanceChangeHub;

    constructor(
        options: Pick<InstanceEditorCoordinatorOptions, "engine" | "instanceRegistry"> &
            Partial<InstanceEditorCoordinatorOptions>,
    ) {
        const defaults = testRuntimeHooks();
        const changes = options.instanceChanges ?? new InstanceChangeHub();
        super({
            ...defaults,
            instanceChanges: changes,
            ...options,
        });
        this.changes = changes;
    }
}

test("config editor returns each patch apply summary to the initiating request", async () => {
    let config = createConfig();
    const registry = new InstanceRegistryFactory().build(config);
    const writes: unknown[] = [];
    const engine = new ConfigEngine({
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(nextConfig);
                config = nextConfig;
            },
        },
        getConfig: () => config,
        runtimePreflight: { async assertAvailable() {} },
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });
    const service = makeConfigEditor(engine);
    const instances = new InstanceEditorCoordinator({
        engine,
        instanceRegistry: registry,
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

    const instanceResult = (await instances.updateInstanceConfig({
        instanceName: "demo-local",
        patch: {
            approvalPolicy: { mode: "ask" },
            security: { mode: "workspace" },
        },
    })) as { appliedChanges: Array<{ kind: string; target: string }> };
    assert.equal(writes.length, 1);
    assert.equal(config.instances[0]?.security.mode, "workspace");
    assert.equal(
        registry.get("demo-local")?.supervision.snapshot().effectiveSecurityMode,
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
    const authResult = (await instances.updateInstanceConfig({
        instanceName: "demo-local",
        patch: {
            mcp: {
                auth: "token",
                contextMode: "explicit",
                token: "0123456789abcdef0123456789abcdef",
            },
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
    const engine = configEngine(
        () => config,
        (nextConfig) => {
            config = nextConfig;
        },
        {
            configStore: {
                async write(nextConfig: ControlConfig) {
                    writes.push(nextConfig);
                    config = nextConfig;
                },
            },
            runtimePreflight: { async assertAvailable() {} },
            runtimeApply: {
                async apply() {
                    runtimeApplyCalls += 1;
                    return false;
                },
            },
        },
    );
    const service = makeConfigEditor(
        engine,
        new InstanceEditorCoordinator({
            engine,
            instanceRegistry: registry,
        }),
    );

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
        registry.get("demo-local")?.supervision.snapshot().effectiveSecurityMode,
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
    const engine = configEngine(
        () => config,
        (nextConfig) => {
            config = nextConfig;
        },
        {
            configStore: {
                async write(nextConfig: ControlConfig) {
                    writes.push(nextConfig);
                    config = nextConfig;
                },
            },
        },
    );
    const service = makeConfigEditor(
        engine,
        new InstanceEditorCoordinator({
            engine,
            instanceRegistry: registry,
        }),
    );

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
            registry.get("demo-local")?.supervision.snapshot().effectiveSecurityMode,
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
    const oauthApprovalToken = "oauth-approval-" + "c".repeat(48);
    let config = createConfig();
    config.mcp.oauth2 = {
        approval: "token",
        token: oauthApprovalToken,
    };
    config.web.auth = { mode: "token", token: strongToken };
    config.instances[0]!.mcp.auth = { mode: "token", token: instanceToken };
    config.instances[0]!.mcp.contextMode = "explicit";
    const registry = new InstanceRegistryFactory().build(config);
    const engine = configEngine(() => config, (nextConfig) => {
        config = nextConfig;
    });
    const service = makeConfigEditor(engine);
    const instances = new InstanceEditorCoordinator({
        engine,
        instanceRegistry: registry,
    });

    const view = service.getConfigView() as {
        instances: Array<Record<string, unknown>>;
        mcp: { oauth2: { token?: string } };
        web: { auth: string; token?: string };
    };
    assert.equal(view.mcp.oauth2.token, MASKED_CONFIG_TOKEN);
    assert.ok(!JSON.stringify(view).includes(oauthApprovalToken));
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
    ) as {
        mcp: { oauth2: { token?: string } };
        web: { token?: string };
    };
    assert.equal(validated.mcp.oauth2.token, MASKED_CONFIG_TOKEN);
    assert.equal(validated.web.token, MASKED_CONFIG_TOKEN);
    assert.ok(!JSON.stringify(validated).includes(oauthApprovalToken));
    assert.ok(!JSON.stringify(validated).includes(strongToken));
    assert.ok(!JSON.stringify(validated).includes(instanceToken));

    await instances.updateInstanceConfig({
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

    await service.updateMcpConfig({
        patch: {
            oauth2: { approval: "token", token: MASKED_CONFIG_TOKEN },
        },
    });
    assert.deepEqual(config.mcp.oauth2, {
        approval: "token",
        token: oauthApprovalToken,
    });

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
    const engine = configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        writes.push(nextConfig);
                        config = nextConfig;
                    },
                },
            },
        );
    const service = makeConfigEditor(engine);

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
    const engine = configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            { configStore: { async write() {} } },
        );
    const service = makeConfigEditor(engine);

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
    const engine = configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        writes.push(nextConfig);
                        config = nextConfig;
                    },
                },
                runtimePreflight: { async assertAvailable() {} },
                runtimeApply: {
                    async apply() {
                        throw new Error("new listener did not become healthy");
                    },
                },
            },
        );
    const service = makeConfigEditor(engine);

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
    const engine = configEngine(
        () => config,
        (nextConfig) => {
            config = nextConfig;
        },
        {
            configStore: {
                async write(nextConfig: ControlConfig) {
                    config = nextConfig;
                },
            },
            runtimeApply: {
                async apply() {
                    applyCalls += 1;
                    return true;
                },
            },
        },
    );
    const service = makeConfigEditor(engine);
    const instances = new InstanceEditorCoordinator({
        engine,
        instanceRegistry: new InstanceRegistryFactory().build(config),
    });

    await instances.updateInstanceConfig({
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

test("config editor hot-applies approval policy and rejects live worker rebuild", async () => {
    let config = createConfig();
    const approvalPolicies: unknown[] = [];
    let stopCalls = 0;
    const instanceDescriptor = descriptor(
        {
            snapshot: runningSnapshot,
            async stop() {
                stopCalls += 1;
                return { ...runningSnapshot(), daemonState: "stopped", ready: false, status: "stopped" };
            },
        },
        {
            approval: {
                close() {},
                async retire() {},
                setPolicy(policy: unknown) {
                    approvalPolicies.push(policy);
                },
            },
        },
    );
    const originalUpdate = instanceDescriptor.update.bind(instanceDescriptor);
    instanceDescriptor.update = (next) => {
        approvalPolicies.push(next.approvalPolicy);
        originalUpdate(next);
    };
    const registry = new InstanceRegistry([instanceDescriptor]);
    const service = createService(
        () => config,
        (next) => { config = next; },
        registry,
    );
    registerLifecycle(service, instanceDescriptor);

    const previous = config;
    await assert.rejects(
        service.updateInstanceConfig({
            instanceName: "demo-local",
            patch: { alerts: { intervalMs: 2_000, maxUncommittedChanges: 5 } },
        }),
        /must be stopped before rebuilding/u,
    );
    assert.equal(config, previous);
    assert.equal(registry.get("demo-local"), instanceDescriptor);
    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: { approvalPolicy: { mode: "ask" } },
    });
    assert.equal(registry.get("demo-local"), instanceDescriptor);
    assert.equal(config.instances[0]?.approvalPolicy?.mode, "ask");
    assert.deepEqual(config.instances[0]?.alerts, previous.instances[0]?.alerts);

    const enabledChanges: boolean[] = [];
    service.changes.onChange(() => {
        enabledChanges.push(registry.get("demo-local")?.config.enabled === true);
    });
    await service.disableInstance({ instanceName: "demo-local" });
    assert.equal(config.instances[0]?.enabled, false);
    assert.equal(stopCalls, 1);
    assert.equal(config.instances[0]?.security.mode, "disabled");
    assert.deepEqual(approvalPolicies, [
        { mode: "ask", rules: undefined },
        { mode: "ask", rules: undefined },
    ]);
    assert.equal(registry.get("demo-local"), undefined);
    assert.deepEqual(enabledChanges, [false]);

    await service.enableInstance({ instanceName: "demo-local" });
    assert.equal(registry.get("demo-local")?.config.enabled, true);
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
    const instanceDescriptor = descriptor(worker, {
        wait: {
            async cancel(waitId: string) {
                cancelledWaits.push(waitId);
                const wait = waits.find((entry) => entry.waitId === waitId)!;
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
    });
    const registry = new InstanceRegistry([instanceDescriptor]);
    const service = createService(
        () => config,
        (next) => {
            config = next;
        },
        registry,
    );
    registerLifecycle(service, instanceDescriptor);

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
    const service = new InstanceEditorCoordinator({
        engine: configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        writes.push(nextConfig);
                        config = nextConfig;
                    },
                },
            },
        ),
        instanceRegistry: registry,
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
    };
    const first = new InstanceEditorCoordinator({
        cleanupDebtFile,
        engine: configEngine(() => config, (nextConfig) => {
            config = nextConfig;
        }),
        createRuntimeInstance: mapper.map,
        instanceRegistry: firstRegistry,
    });
    first.registerInstanceGenerationRetirement(async () => {
        throw new Error("terminal retirement failed");
    });

    const warnings = await captureWarnings(
        async () => await first.disableInstance({ instanceName: "demo-local" }),
    );

    assert.equal(config.instances[0]?.enabled, false);
    assert.equal(firstRegistry.get("demo-local"), undefined);
    assert.equal(warnings.length, 1);

    const secondRegistry = new InstanceRegistry([]);
    const second = new InstanceEditorCoordinator({
        cleanupDebtFile,
        engine: configEngine(() => config, (nextConfig) => {
            config = nextConfig;
        }),
        createRuntimeInstance: mapper.map,
        instanceRegistry: secondRegistry,
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
    const root = await createTestTempDirectory(
        "instance-cleanup-debt-write-failure",
    );
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
    };
    const service = new InstanceEditorCoordinator({
        cleanupDebtFile,
        engine: configEngine(() => config, (nextConfig) => {
            config = nextConfig;
        }),
        createRuntimeInstance: mapper.map,
        instanceRegistry: registry,
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
    const service = new InstanceEditorCoordinator({
        cleanupDebtFile,
        engine: configEngine(() => config, (nextConfig) => {
            config = nextConfig;
        }),
        instanceRegistry: new InstanceRegistry([]),
    });

    await assert.rejects(service.reconcileCleanupDebt(), SyntaxError);
    await assert.rejects(service.reconcileCleanupDebt(), SyntaxError);
});

test("every disable entrypoint commits before cleanup and runs committed lifecycle once", async (t) => {
    const entrypoints: Array<{
        name: string;
        run(services: {
            config: ConfigEditorCoordinator;
            instance: InstanceEditorCoordinator;
        }): Promise<unknown>;
    }> = [
        {
            name: "disableInstance",
            run: async ({ instance }) =>
                await instance.disableInstance({
                    instanceName: "demo-local",
                }),
        },
        {
            name: "updateInstanceConfig",
            run: async ({ instance }) =>
                await instance.updateInstanceConfig({
                    instanceName: "demo-local",
                    patch: { enabled: false },
                }),
        },
        {
            name: "updateConfig",
            run: async ({ config }) =>
                await config.updateConfig({
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
            const waiting = {
                status: "waiting",
                waitId: "wait-retirement-failure",
            };
            const instanceDescriptor = descriptor(
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
            );
            const registry = new InstanceRegistry([instanceDescriptor]);
            const engine = configEngine(
                () => config,
                (nextConfig) => {
                    config = nextConfig;
                },
                {
                    configStore: {
                        async write(nextConfig: ControlConfig) {
                            writes.push(nextConfig);
                            config = nextConfig;
                        },
                    },
                },
            );
            const instance = new InstanceEditorCoordinator({
                engine,
                instanceRegistry: registry,
            });
            registerLifecycle(instance, instanceDescriptor);
            const configEditor = makeConfigEditor(engine, instance);

            const warnings = await captureWarnings(
                async () =>
                    await entrypoint.run({
                        config: configEditor,
                        instance,
                    }),
            );
            assert.equal(stopCalls, 1);
            assert.equal(startCalls, 0);
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
    const service = new InstanceEditorCoordinator({
        engine: configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        actions.push("config.write");
                        config = nextConfig;
                    },
                },
            },
        ),
        instanceRegistry: registry,
    });
    service.registerInstanceDisableRetirement(async (instance) => {
        actions.push(`interaction.retire:${instance.name}`);
    });

    await service.disableInstance({ instanceName: "demo-local" });

    assert.deepEqual(actions.slice(0, 3), [
        "config.write",
        "interaction.retire:demo-local",
        "worker.stop",
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
    const service = new InstanceEditorCoordinator({
        engine: configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write() {
                        throw new Error("config persistence failed");
                    },
                },
            },
        ),
        instanceRegistry: registry,
    });

    await assert.rejects(
        service.disableInstance({ instanceName: "demo-local" }),
        /config persistence failed/u,
    );
    assert.equal(stopCalls, 0);
    assert.equal(startCalls, 0);
    assert.equal(config.instances[0]?.enabled, true);
    assert.equal(registry.get("demo-local")?.config.enabled, true);
});

test("Control disable does not stop self-managed reverse workers but retires local pending interactions", async () => {
    let config = createConfig();
    let stopCalls = 0;
    const cancelledApprovals: string[] = [];
    const cancelledWaits: string[] = [];
    const instanceDescriptor = descriptor(
        {
            managementMode: "selfManaged",
            snapshot: runningSnapshot,
            async stop() {
                stopCalls += 1;
                throw new Error("must not stop self-managed worker");
            },
        },
        {
            approval: {
                close() {},
                async retire() {
                    cancelledApprovals.push("approval-self-managed");
                },
                setPolicy() {},
            },
            wait: {
                async cancel(waitId: string) {
                    cancelledWaits.push(waitId);
                    return { status: "cancelled", waitId };
                },
                async get() {
                    return undefined;
                },
                async list() {
                    return [{ status: "waiting", waitId: "wait-self-managed" }];
                },
            },
        },
    );
    const registry = new InstanceRegistry([instanceDescriptor]);
    const service = createService(
        () => config,
        (next) => {
            config = next;
        },
        registry,
    );
    registerLifecycle(service, instanceDescriptor);

    await service.disableInstance({ instanceName: "demo-local" });

    assert.equal(stopCalls, 0);
    assert.deepEqual(cancelledApprovals, ["approval-self-managed"]);
    assert.deepEqual(cancelledWaits, ["wait-self-managed"]);
    assert.equal(config.instances[0]?.enabled, false);
    assert.equal(registry.get("demo-local"), undefined);
});

test("batch instance failure restores a hot-applied endpoint before configuration and descriptor state", async () => {
    let config = createConfig();
    const previous = config;
    const actions: string[] = [];
    const writes: ControlConfig[] = [];
    const failure = new Error("worker reconfigure failed");
    let runtimePolicyMode = "none";
    let runtimeWebEnabled = previous.web.enabled;
    let updateCalls = 0;
    const originalDescriptor = descriptor({ snapshot: stoppedSnapshot });
    const originalUpdate = originalDescriptor.update.bind(originalDescriptor);
    originalDescriptor.update = (next) => {
        updateCalls += 1;
        runtimePolicyMode = next.approvalPolicy?.mode ?? "none";
        actions.push(`instance:${runtimePolicyMode}`);
        if (updateCalls === 1) throw failure;
        originalUpdate(next);
    };
    const registry = new InstanceRegistry([originalDescriptor]);
    const changes = new ConfigChangeHub();
    const engine = configEngine(
        () => config,
        (nextConfig) => {
            config = nextConfig;
        },
        {
            changeHub: changes,
            configStore: {
                async write(nextConfig: ControlConfig) {
                    actions.push(`persist:${nextConfig.web.enabled}`);
                    writes.push(nextConfig);
                },
            },
            runtimeApply: {
                apply: async (
                    _previous: ControlConfig,
                    nextConfig: ControlConfig,
                ) => {
                    runtimeWebEnabled = nextConfig.web.enabled;
                    actions.push(`runtime:${runtimeWebEnabled}`);
                    return true;
                },
            },
            runtimePreflight: { async assertAvailable() {} },
        },
    );
    const service = makeConfigEditor(
        engine,
        new InstanceEditorCoordinator({
            engine,
            instanceRegistry: registry,
        }),
    );

    await assert.rejects(
        service.updateConfig({
            instance: {
                instanceName: "demo-local",
                patch: {
                    approvalPolicy: { mode: "ask" },
                },
            },
            web: { enabled: true },
        }),
        failure,
    );

    assert.deepEqual(actions, [
        "persist:true",
        "runtime:true",
        "instance:ask",
        "runtime:false",
        "persist:false",
        "instance:none",
    ]);
    assert.equal(writes.length, 2);
    assert.equal(writes[1], previous);
    assert.equal(config, previous);
    assert.equal(runtimePolicyMode, "none");
    assert.equal(updateCalls, 2);
    assert.equal(runtimeWebEnabled, previous.web.enabled);
    assert.equal(registry.get("demo-local"), originalDescriptor);
    assert.equal(changes.revision, 0);
});

test("instance reconfigure failure restores persisted and runtime configuration", async () => {
    let config = createConfig();
    const writes: ControlConfig[] = [];
    let runtimePolicyMode = "none";
    let failNext = true;
    const originalDescriptor = descriptor({ snapshot: stoppedSnapshot });
    const originalUpdate = originalDescriptor.update.bind(originalDescriptor);
    originalDescriptor.update = (next) => {
        runtimePolicyMode = next.approvalPolicy?.mode ?? "none";
        if (failNext) {
            failNext = false;
            throw new Error("instance update failed");
        }
        originalUpdate(next);
    };
    const registry = new InstanceRegistry([originalDescriptor]);
    const service = new InstanceEditorCoordinator({
        engine: configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        writes.push(structuredClone(nextConfig));
                        config = nextConfig;
                    },
                },
            },
        ),
        instanceRegistry: registry,
    });

    await assert.rejects(
        service.updateInstanceConfig({
            instanceName: "demo-local",
            patch: { approvalPolicy: { mode: "ask" } },
        }),
        /instance update failed/u,
    );

    assert.equal(writes.length, 2);
    assert.equal(config.instances[0]?.security.mode, "disabled");
    assert.equal(config.instances[0]?.approvalPolicy, undefined);
    assert.equal(runtimePolicyMode, "none");
    assert.equal(registry.get("demo-local"), originalDescriptor);
    assert.equal(originalDescriptor.config.enabled, true);
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
    const service = new InstanceEditorCoordinator({
        engine: configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        actions.push("config.write");
                        config = nextConfig;
                    },
                },
            },
        ),
        createRuntimeInstance: () => {
            actions.push("replacement.prepare");
            return replacement;
        },
        instanceRegistry: registry,
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
    const service = new InstanceEditorCoordinator({
        cleanupDebtFile,
        engine: configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        writes.push(structuredClone(nextConfig));
                        config = nextConfig;
                    },
                },
            },
        ),
        createRuntimeInstance: () => replacement,
        instanceRegistry: registry,
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
    const restarted = new InstanceEditorCoordinator({
        cleanupDebtFile,
        engine: configEngine(() => config, (nextConfig) => {
            config = nextConfig;
        }),
        instanceRegistry: restartedRegistry,
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
    const service = new InstanceEditorCoordinator({
        engine: configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write() {
                        throw new Error("rebuild persistence failed");
                    },
                },
            },
        ),
        createRuntimeInstance: () => replacement,
        instanceRegistry: registry,
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

test("instance delete detaches Context before terminal resource cleanup", async () => {
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
                approval: {
                    close() {},
                    async retire() {
                        actions.push("approval.retire");
                    },
                    setPolicy() {},
                },
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
    const service = new InstanceEditorCoordinator({
        engine: configEngine(() => config, (nextConfig) => {
            config = nextConfig;
        }),
        detachContextInstance: async (instance) => {
            actions.push(`context.detach:${instance}`);
        },
        instanceRegistry: registry,
        mcp: {
            registerInstance() {},
            async retireMcpApp() {},
            unregisterInstance(instance: string) {
                actions.push(`mcp.unregister:${instance}`);
            },
        },
    });
    registerLifecycle(service, registry.get("demo-local"));

    await service.deleteInstance({ instanceName: "demo-local" });

    assert.deepEqual(actions, [
        "mcp.unregister:demo-local",
        "context.detach:demo-local",
        "approval.retire",
        "wait.cancel:wait-live",
        "wait.consume:wait-result",
        "goals.stopAll",
        "todos.cancelAll",
        "runtime.retire",
        "provider.retire",
        "worker.close",
    ]);
    assert.equal(config.instances.length, 0);
    assert.equal(registry.get("demo-local"), undefined);
});

test("deleting a disabled MCP instance preserves and reattaches its Context", async (t) => {
    const contextHome = await createTestTempDirectory(
        "config-delete-context-isolated",
    );
    t.after(
        async () => await rm(contextHome, { force: true, recursive: true }),
    );
    const contextPath = join(contextHome, "contexts.json");
    let config = createConfig();
    config.mcp.enabled = false;
    config.instances[0]!.enabled = false;
    const instances = new InstanceRegistry([]);
    const contexts = createContextRuntime({
        contextFile: contextPath,
        environment: () => testEnvironmentTransport,
        leaseInstance: () => ({ release() {} }),
        process: () => testProcessTransport,
        runtime: () => testInstanceRuntimeTransport,
    });
    await contexts.initialize();
    const context = await contexts.api.registry.create({
        principal: "local",
        environments: [{ instance: "demo-local", workspace: "/historical" }],
    });
    const service = new InstanceEditorCoordinator({
        cleanupDebtFile: join(contextHome, "cleanup-debt.json"),
        engine: configEngine(() => config, (nextConfig) => {
            config = nextConfig;
        }),
        detachContextInstance: async (instance) => {
            await contexts.api.detachInstance(instance);
        },
        instanceRegistry: instances,
    });

    await service.deleteInstance({ instanceName: "demo-local" });

    assert.equal(config.instances.length, 0);
    const detached = await contexts.api.registry.lookup(context.ctxId, {
        principal: "local",
    });
    assert.equal(detached.status, "active");
    assert.deepEqual(detached.environments, []);
    assert.equal((await contexts.api.renew(context.ctxId)).status, "active");

    const restoredContexts = createContextRuntime({
        contextFile: contextPath,
        environment: () => testEnvironmentTransport,
        leaseInstance: () => ({ release() {} }),
        process: () => testProcessTransport,
        runtime: () => testInstanceRuntimeTransport,
    });
    await restoredContexts.initialize();
    assert.deepEqual(
        (
            await restoredContexts.api.registry.lookup(context.ctxId, {
                principal: "local",
            })
        ).environments,
        [],
    );
    await restoredContexts.api.registry.attachEnvironment(context.ctxId, {
        instance: "replacement",
        workspace: "/replacement",
    });
    assert.deepEqual(
        (
            await restoredContexts.api.registry.lookup(context.ctxId, {
                principal: "local",
            })
        ).environments,
        [{ instance: "replacement", workspace: "/replacement" }],
    );
});

test("instance deletion starts cleanup-only worker before releasing pending Context alerts", async (t) => {
    const contextHome = await createTestTempDirectory(
        "config-delete-context-alerts",
    );
    t.after(
        async () => await rm(contextHome, { force: true, recursive: true }),
    );
    const instanceName = "demo-local";
    const events: string[] = [];
    let ready = false;
    const worker = {
        managementMode: "controllerManaged",
        snapshot: () => ({
            daemonState: ready ? "running" : "stopped",
            ready,
        }),
        async start() {
            events.push("worker.start");
            ready = true;
        },
        async stop() {
            events.push("worker.stop");
            ready = false;
        },
        async releaseAlerts(workspace: string) {
            assert.equal(ready, true);
            events.push(`alerts.release:${workspace}`);
        },
        async retireRuntime() {
            events.push("worker.retire");
        },
        async retireProviderResources() {
            events.push("provider.retire");
        },
        async close() {
            events.push("worker.close");
        },
    };
    const removedDescriptor = descriptor(worker, {
        approval: {
            async retire() {},
            close() {},
        },
    });
    const instances = new InstanceRegistry([removedDescriptor]);
    let config = createConfig();
    config.mcp.enabled = false;
    config.instances[0]!.enabled = false;
    const cleanupOnly = new Map<string, ReturnType<typeof descriptor>>();
    const contexts = createContextRuntime({
        contextFile: join(contextHome, "contexts.json"),
        environment: () => testEnvironmentTransport,
        leaseInstance: () => ({ release() {} }),
        process: () => testProcessTransport,
        runtime: () => testInstanceRuntimeTransport,
    });
    await contexts.initialize();
    const context = await contexts.api.registry.create({
        principal: "local",
        environments: [{ instance: instanceName, workspace: "/historical" }],
    });
    await contexts.api.registry.recordEnvironmentCleanup(context.ctxId, {
        instance: instanceName,
        kind: "instance_reference",
    });
    await contexts.api.registry.recordEnvironmentCleanup(context.ctxId, {
        instance: instanceName,
        kind: "alerts",
        workspace: "/historical",
    });
    const service = new InstanceEditorCoordinator({
        cleanupDebtFile: join(contextHome, "cleanup-debt.json"),
        engine: configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        config = nextConfig;
                    },
                },
            },
        ),
        detachContextInstance: async (instance) => {
            await contexts.api.detachInstance(instance);
        },
        instanceRegistry: instances,
        reconcileContextInstanceCleanup: async (instance, target) =>
            await contexts.api.cleanup.reconcileInstance(instance, target),
    });

    await service.deleteInstance({ instanceName });

    assert.deepEqual(events, [
        "worker.start",
        "alerts.release:/historical",
        "worker.stop",
        "worker.retire",
        "provider.retire",
        "worker.close",
    ]);
    assert.equal(instances.get(instanceName), undefined);
    assert.deepEqual(await contexts.api.registry.listEnvironmentCleanup(), []);
    await contexts.reconcile();
});

test("failed Context cleanup keeps both debts and cleanup capability through retry and replay", async (t) => {
    const root = await createTestTempDirectory(
        "config-delete-context-alerts-retry",
    );
    t.after(async () => await rm(root, { force: true, recursive: true }));

    const exercise = async (mode: "retry" | "replay") => {
        const instanceName = mode === "retry" ? "demo-local" : "demo-replay";
        const contextHome = join(root, mode);
        const contextPath = join(contextHome, "contexts.json");
        const cleanupDebtFile = join(contextHome, "cleanup-debt.json");
        const events: string[] = [];
        let allowRelease = false;
        let ready = false;
        const instances = new InstanceRegistry([]);
        const worker = {
            managementMode: "controllerManaged",
            snapshot: () => ({
                daemonState: ready ? "running" : "stopped",
                ready,
            }),
            async start() {
                assert.equal(instances.get(instanceName), undefined);
                events.push("worker.start");
                ready = true;
            },
            async releaseAlerts(workspace: string) {
                assert.equal(ready, true);
                events.push(`alerts.release:${workspace}`);
                if (!allowRelease)
                    throw new Error("alerts release unavailable");
            },
            async retireRuntime() {
                events.push("worker.retire");
            },
            async retireProviderResources() {
                events.push("provider.retire");
            },
            async close() {
                events.push("worker.close");
            },
        };
        const originalDescriptor = descriptor(worker, {
            name: instanceName,
            mcpPath: `/${instanceName}/mcp`,
            approval: {
                async retire() {},
                close() {},
            },
        });
        instances.add(originalDescriptor);
        let config = createConfig();
        config.instances[0]!.name = instanceName;
        config.instances[0]!.mcp.path = `/${instanceName}/mcp`;
        config.instances[0]!.enabled = false;
        config.mcp.enabled = false;
        const cleanupOnly = new Map<string, ReturnType<typeof descriptor>>();
        const contexts = createContextRuntime({
            contextFile: contextPath,
            environment: () => testEnvironmentTransport,
            leaseInstance: () => ({ release() {} }),
            process: () => testProcessTransport,
            runtime: () => testInstanceRuntimeTransport,
        });
        await contexts.initialize();
        const context = await contexts.api.registry.create({
            principal: "local",
            environments: [
                { instance: instanceName, workspace: "/historical" },
            ],
        });
        await contexts.api.registry.recordEnvironmentCleanup(context.ctxId, {
            instance: instanceName,
            kind: "alerts",
            workspace: "/historical",
        });

        const makeService = (
            registry: InstanceRegistry,
            mapDescriptor?: ReturnType<typeof descriptor>,
        ) =>
            new InstanceEditorCoordinator({
                cleanupDebtFile,
                engine: configEngine(
                    () => config,
                    (nextConfig) => {
                        config = nextConfig;
                    },
                    {
                        configStore: {
                            async write(nextConfig: ControlConfig) {
                                config = nextConfig;
                            },
                        },
                    },
                ),
                detachContextInstance: async (instance) => {
                    await contexts.api.detachInstance(instance);
                },
                createRuntimeInstance: (instance) =>
                    mapDescriptor ?? createTestInstance(instance),
                instanceRegistry: registry,
                reconcileContextInstanceCleanup: async (instance, target) =>
                    await contexts.api.cleanup.reconcileInstance(instance, target),
            });

        const service = makeService(instances);
        const warnings = await captureWarnings(async () => {
            await service.deleteInstance({ instanceName });
        });
        assert.equal(warnings.length, 1);
        assert.equal(instances.get(instanceName), undefined);
        assert.deepEqual(await contexts.api.registry.listEnvironmentCleanup(), [
            {
                ctxId: context.ctxId,
                cleanup: {
                    instance: instanceName,
                    kind: "alerts",
                    workspace: "/historical",
                },
            },
        ]);
        const persistedDebt = JSON.parse(
            await readFile(cleanupDebtFile, "utf8"),
        ) as Array<{ instance: { name: string }; operation: string }>;
        assert.equal(persistedDebt[0]?.instance.name, instanceName);
        assert.equal(persistedDebt[0]?.operation, "delete");
        assert.equal(events.includes("worker.close"), false);
        assert.equal(events.includes("worker.retire"), false);

        allowRelease = true;
        if (mode === "retry") {
            await service.reconcileCleanupDebt();
        } else {
            const replayRegistry = new InstanceRegistry([]);
            let replayReady = false;
            const replayDescriptor = descriptor(
                {
                    ...worker,
                    snapshot: () => ({
                        daemonState: replayReady ? "running" : "stopped",
                        ready: replayReady,
                    }),
                    async start() {
                        assert.equal(
                            replayRegistry.get(instanceName),
                            undefined,
                        );
                        events.push("replay.start");
                        replayReady = true;
                    },
                    async releaseAlerts(workspace: string) {
                        assert.equal(replayReady, true);
                        events.push(`alerts.release:${workspace}`);
                        if (!allowRelease)
                            throw new Error("alerts release unavailable");
                    },
                },
                {
                    name: instanceName,
                    mcpPath: `/${instanceName}/mcp`,
                    approval: { async retire() {}, close() {} },
                },
            );
            await makeService(
                replayRegistry,
                replayDescriptor,
            ).reconcileCleanupDebt();
            assert.equal(replayRegistry.get(instanceName), undefined);
            assert.ok(events.includes("replay.start"));
        }
        assert.deepEqual(await contexts.api.registry.listEnvironmentCleanup(), []);
        assert.equal(
            JSON.parse(await readFile(cleanupDebtFile, "utf8")).length,
            0,
        );
        assert.equal(events.at(-1), "worker.close");
        assert.ok(
            events.indexOf("alerts.release:/historical") <
                events.indexOf("worker.close"),
        );
    };

    await exercise("retry");
    await exercise("replay");
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
    registerLifecycle(service, registry.get("demo-local"));

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
    registerLifecycle(service, registry.get("demo-local"));

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
    const service = new InstanceEditorCoordinator({
        engine: configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        actions.push(
                            `config.write:${nextConfig.instances.length}`,
                        );
                        config = nextConfig;
                    },
                },
            },
        ),
        instanceRegistry: registry,
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
    const service = new InstanceEditorCoordinator({
        engine: configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        writes.push(nextConfig.instances.length);
                        config = nextConfig;
                    },
                },
            },
        ),
        instanceRegistry: registry,
    });
    service.registerInstanceDeleteRetirement(async () => {
        throw new Error("generation retirement failed");
    });

    const warnings = await captureWarnings(
        async () =>
            await service.deleteInstance({ instanceName: "demo-local" }),
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
    const service = new InstanceEditorCoordinator({
        engine: configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        writes.push(nextConfig.instances.length);
                        config = nextConfig;
                    },
                },
            },
        ),
        instanceRegistry: registry,
    });

    registerLifecycle(service, registry.get("demo-local"));
    const warnings = await captureWarnings(
        async () =>
            await service.deleteInstance({ instanceName: "demo-local" }),
    );
    assert.deepEqual(writes, [0]);
    assert.equal(config.instances.length, 0);
    assert.equal(registry.get("demo-local"), undefined);
    assert.equal(warnings.length, 1);
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
    const service = new InstanceEditorCoordinator({
        engine: configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write() {
                        throw new Error("delete persistence failed");
                    },
                },
            },
        ),
        detachContextInstance: async (instance) => {
            actions.push(`context.detach:${instance}`);
        },
        instanceRegistry: registry,
    });
    await assert.rejects(
        service.deleteInstance({ instanceName: "demo-local" }),
        /delete persistence failed/u,
    );
    assert.deepEqual(actions, []);
    assert.equal(config.instances.length, 1);
    assert.notEqual(registry.get("demo-local"), undefined);
});

test("instance delete commits failed and stale local instances while retaining unresolved runtime cleanup", async () => {
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

        const result = await service.deleteInstance({ instanceName: "demo-local" }) as Record<string, unknown>;
        assert.equal(result.cleanupPending, true);
        assert.equal((await service.listCleanupDebts())[0]!.state, "pending");

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
            ["runtime", "provider"],
            `${daemonState} must retain failed runtime cleanup and still attempt provider cleanup`,
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

test("config editor allows deleting a running instance but rejects rebuild patches", async () => {
    let config = createConfig();
    const writes: unknown[] = [];
    const registry = new InstanceRegistry([
        descriptor({ snapshot: runningSnapshot }),
    ]);
    const service = new InstanceEditorCoordinator({
        engine: configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        writes.push(nextConfig);
                        config = nextConfig;
                    },
                },
            },
        ),
        instanceRegistry: registry,
    });

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
    const result = await service.deleteInstance({ instanceName: "demo-local" }) as Record<string, unknown>;
    assert.equal(result.cleanupPending, false);
    assert.equal(writes.length, 1);
    assert.deepEqual(config.instances, []);
});

test("config editor hot-applies model Extension ACL and MCP context changes without restarting control", async () => {
    let config = createConfig();
    config.instances[0]!.mcp.contextMode = "explicit";
    config.instances[0]!.workspace.enabled = true;
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
    const registered: Array<{
        auth: unknown;
        instance: string;
    }> = [];
    const retiredMcpApps: string[] = [];
    const unregistered: string[] = [];
    const mcp = {
        registerInstance(instance: string, auth: unknown) {
            registered.push({ auth, instance });
        },
        async retireMcpApp(instanceName: string) {
            retiredMcpApps.push(instanceName);
        },
        unregisterInstance(instanceName: string) {
            unregistered.push(instanceName);
        },
    };
    const service = new InstanceEditorCoordinator({
        engine: configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        config = nextConfig;
                    },
                },
            },
        ),
        detachContextInstance: async () => undefined,
        instanceRegistry: registry,
        mcp: mcp as never,
    });

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: {
            extensions: { model: ["instance", "artifact"] },
        },
    });

    assert.equal(registered.length, 1);
    assert.deepEqual(retiredMcpApps, []);
    assert.equal(registered[0]?.instance, "demo-local");
    assert.deepEqual(registered[0]?.auth, { mode: "none" });
    assert.deepEqual(registry.get("demo-local")?.config.modelExtensions, [
        "instance",
        "artifact",
    ]);

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: { mcp: { contextMode: "openai-session" } },
    });
    assert.equal(registered[1]?.instance, "demo-local");
    assert.equal(config.instances[0]?.workspace.enabled, true);
    assert.equal(registry.get("demo-local")?.config.mcpContextMode, "openai-session");

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: { workspace: { enabled: false } },
    });
    assert.deepEqual(retiredMcpApps, ["demo-local"]);
    assert.equal(registered[2]?.instance, "demo-local");
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
    assert.deepEqual(registered[3]?.auth, {
        mode: "token",
        token: "0123456789abcdef0123456789abcdef",
    });
    assert.deepEqual(authUpdate.appliedChanges, [
        { kind: "instance.updated", target: "demo-local" },
    ]);

    await service.disableInstance({ instanceName: "demo-local" });
    assert.deepEqual(unregistered, ["demo-local"]);
    assert.deepEqual(retiredMcpApps, ["demo-local", "demo-local"]);
    await service.enableInstance({ instanceName: "demo-local" });
    assert.equal(registered.length, 5);
    assert.equal(config.instances[0]?.workspace.enabled, false);
    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: { workspace: { enabled: true } },
    });
    assert.equal(registered.length, 6);
    assert.equal(config.instances[0]?.workspace.enabled, true);
    await service.deleteInstance({ instanceName: "demo-local" });
    assert.deepEqual(unregistered, ["demo-local", "demo-local"]);
    assert.equal(registry.get("demo-local"), undefined);
});

test("config editor applies Core path updates transactionally and restores on runtime failure", async () => {
    let config = createConfig();
    const writes: ControlConfig[] = [];
    const runtimeChanges: Array<{
        mcp: boolean;
        web: boolean;
    }> = [];
    const committed: string[][] = [];
    const changeHub = new ConfigChangeHub();
    changeHub.onChange((change) => committed.push([...change.paths]));
    let failRuntime = false;
    const engine = configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                changeHub,
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        writes.push(structuredClone(nextConfig));
                    },
                },
                runtimeApply: {
                    async apply(
                        _previous: ControlConfig,
                        _next: ControlConfig,
                        changes: ConfigRuntimeChangeSet,
                    ) {
                        runtimeChanges.push({
                            mcp: changes.mcp,
                            web: changes.web,
                        });
                        if (failRuntime)
                            throw new Error("runtime apply failed");
                        return true;
                    },
                },
                runtimePreflight: { async assertAvailable() {} },
            },
        );
    const service = makeConfigEditor(engine);

    await service.updateCorePaths({
        "mcp.publicBaseUrl": "https://public.example.test/mcp",
    });
    assert.equal(config.mcp.publicBaseUrl, "https://public.example.test/mcp");
    assert.deepEqual(runtimeChanges, [{ mcp: true, web: false }]);
    assert.deepEqual(committed, [["mcp.publicBaseUrl"]]);

    const previousWebUrl = config.web.publicBaseUrl;
    failRuntime = true;
    await assert.rejects(
        async () =>
            await service.updateCorePaths({
                "web.publicBaseUrl": "https://public.example.test/web",
            }),
        /runtime apply failed/u,
    );
    assert.equal(config.web.publicBaseUrl, previousWebUrl);
    assert.equal(
        writes.at(-1)?.web.publicBaseUrl,
        previousWebUrl,
        "rollback persists the previous Core Config",
    );
    assert.deepEqual(committed, [["mcp.publicBaseUrl"]]);
});

test("MCP OAuth2 approval changes also invalidate an active Web OAuth2 runtime", async () => {
    let config = createConfig();
    config.web = {
        ...config.web,
        auth: {
            mode: "oauth2",
            oauth2: { requiredScopes: ["web"], resourceName: "web" },
        },
        enabled: true,
    };
    const changes: Array<{ mcp: boolean; web: boolean }> = [];
    const engine = configEngine(
            () => config,
            (nextConfig) => {
                config = nextConfig;
            },
            {
                configStore: {
                    async write(nextConfig: ControlConfig) {
                        config = nextConfig;
                    },
                },
                runtimeApply: {
                    async apply(
                        _previous: ControlConfig,
                        _next: ControlConfig,
                        runtimeChanges: ConfigRuntimeChangeSet,
                    ) {
                        changes.push({
                            mcp: runtimeChanges.mcp,
                            web: runtimeChanges.web,
                        });
                        return true;
                    },
                },
                runtimePreflight: { async assertAvailable() {} },
            },
        );
    const service = makeConfigEditor(engine);

    await service.updateMcpConfig({
        patch: {
            oauth2: { approval: "token", token: "o".repeat(48) },
        },
    });

    assert.deepEqual(changes, [{ mcp: true, web: true }]);
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

function configEngine(
    getConfig: () => ReturnType<typeof createConfig>,
    setConfig: (config: ReturnType<typeof createConfig>) => void,
    options: Omit<
        ConfigEngineOptions,
        "configStore" | "getConfig" | "setConfig"
    > & { configStore?: ConfigEngineOptions["configStore"] } = {},
) {
    return new ConfigEngine({
        configStore: {
            async write(nextConfig: ControlConfig) {
                setConfig(nextConfig);
            },
        },
        getConfig,
        runtimePreflight: new HttpEndpointPreflight(),
        setConfig,
        ...options,
    });
}

function makeConfigEditor(
    engine: ConfigEngine,
    instances?: InstanceEditorCoordinator,
): ConfigEditorCoordinator {
    return new ConfigEditorCoordinator({ engine, instances });
}

function requireCleanupDescriptor(
    value: Instance | undefined,
): Instance {
    if (value === undefined)
        throw new Error("Expected a Context cleanup descriptor.");
    return value;
}

function createService(
    getConfig: () => ReturnType<typeof createConfig>,
    setConfig: (config: ReturnType<typeof createConfig>) => void,
    registry: InstanceRegistry,
): InstanceEditorCoordinator {
    return new InstanceEditorCoordinator({
        engine: configEngine(getConfig, setConfig),
        instanceRegistry: registry,
    });
}

function descriptor(
    worker: Record<string, unknown>,
    extra: Record<string, unknown> = {},
) {
    const config = normalizeConfigInstanceDraft({
        enabled: (extra.enabled as boolean | undefined) ?? true,
        extensions: {
            model:
                (extra.modelExtensions as string[] | undefined) ?? ["instance"],
        },
        mcp: {
            contextMode:
                (extra.mcpContextMode as "explicit" | "openai-session" | undefined) ??
                "openai-session",
            enabled: (extra.mcpEnabled as boolean | undefined) ?? true,
            path: (extra.mcpPath as string | undefined) ?? "/demo-local/mcp",
        },
        name: (extra.name as string | undefined) ?? "demo-local",
        provider: (extra.provider as "local" | undefined) ?? "local",
    });
    const instance = createTestInstance(config, {
        managementMode: "controllerManaged",
        async retireRuntime() {},
        async retireProviderResources() {},
        ...worker,
    });
    const runtimeFields = {
        approval: {
            close() {},
            async retire() {},
            setPolicy() {},
        },
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
        todo: {
            async cancelAll() {},
            async control() {
                throw new Error("unused");
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
    };
    const reserved = new Set([
        "enabled",
        "mcpEnabled",
        "mcpPath",
        "mcpContextMode",
        "modelExtensions",
        "name",
        "provider",
        "worker",
    ]);
    for (const [key, value] of Object.entries(extra)) {
        if (!reserved.has(key))
            (runtimeFields as Record<string, unknown>)[key] = value;
    }
    return Object.assign(instance, runtimeFields);
}

interface TestLifecycleDescriptor {
    approval: {
        retire(reason: string): Promise<void>;
        setPolicy(policy: unknown): void;
    };
    goal?: { stopAll(): Promise<unknown> };
    todo?: { cancelAll(): Promise<void> };
    wait?: {
        cancel(waitId: string): Promise<unknown>;
        consume?(waitId: string): Promise<unknown>;
        get?(waitId: string): Promise<unknown>;
        list(): Promise<Array<{ status: string; waitId: string }>>;
    };
}

/**
 * Mirrors the lifecycle retirement the production InstanceDomainRuntime performs
 * via the InstanceEditorCoordinator retirement listener ports, using the
 * descriptor's mock domain services so tests can assert the same interactions.
 */
function registerLifecycle(
    editor: InstanceEditorCoordinator,
    descriptorValue: unknown,
): void {
    const d = descriptorValue as TestLifecycleDescriptor;
    editor.registerInstanceDisableRetirement(async (instance) => {
        d.approval.setPolicy(instance.approvalPolicy);
        await d.approval.retire(
            `Instance ${instance.name} was disabled before approval.`,
        );
        if (d.wait !== undefined) {
            for (const wait of await d.wait.list()) {
                if (wait.status !== "waiting" && wait.status !== "detached")
                    continue;
                await d.wait.cancel(wait.waitId);
            }
        }
    });
    editor.registerInstanceDeleteRetirement(async (instance) => {
        const failures: unknown[] = [];
        await d.approval
            .retire(`Instance ${instance.name} was deleted.`)
            .catch((error) => failures.push(error));
        if (d.wait !== undefined) {
            try {
                for (const wait of await d.wait.list()) {
                    if (
                        wait.status !== "waiting" &&
                        wait.status !== "detached" &&
                        wait.status !== "resolved"
                    )
                        continue;
                    try {
                        if (wait.status === "resolved")
                            await d.wait.consume?.(wait.waitId);
                        else await d.wait.cancel(wait.waitId);
                    } catch (error) {
                        let current: { status?: string } | undefined;
                        try {
                            current = (await d.wait.get?.(wait.waitId)) as
                                | { status?: string }
                                | undefined;
                        } catch (readError) {
                            failures.push(error, readError);
                            continue;
                        }
                        if (
                            current === undefined ||
                            current.status === "cancelled" ||
                            current.status === "consumed"
                        )
                            continue;
                        failures.push(error);
                    }
                }
            } catch (error) {
                failures.push(error);
            }
        }
        await d.goal?.stopAll().catch((error) => failures.push(error));
        await d.todo?.cancelAll().catch((error) => failures.push(error));
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                `Instance ${instance.name} domain retirement was incomplete.`,
            );
    });
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

async function captureWarnings(
    operation: () => Promise<unknown>,
): Promise<unknown[]> {
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
