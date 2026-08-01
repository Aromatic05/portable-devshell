import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import {
    ConfigEditorCoordinator,
    InstanceRegistry,
    InstanceRegistryFactory,
    createDefaultControlConfig
} from "../../src/testing.ts";
import { normalizeConfigInstanceDraft, type ControlConfig, type JsonValue } from "@portable-devshell/shared";

test("config editor validates drafts and accumulates patch apply summaries", async () => {
    let config = createConfig();
    const registry = new InstanceRegistryFactory().build(config);
    const writes: unknown[] = [];
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(nextConfig);
                config = nextConfig;
            }
        },
        getConfig: () => config,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        }
    });

    const view = service.getConfigView() as { instances: Array<{ security: { effectiveMode: string; mode: string } }> };
    assert.equal(view.instances[0]?.security.mode, "disabled");
    assert.equal(view.instances[0]?.security.effectiveMode, "disabled");

    const configView = service.getConfigView() as { instances: Array<Record<string, unknown>> } & Record<string, unknown>;
    const validated = service.validateConfigDraft({
        ...configView,
        instances: [
            {
                ...configView.instances[0],
                approvalPolicy: { mode: "ask" },
                security: { mode: "workspace" }
            }
        ]
    } as unknown as JsonValue) as { instances: Array<{ security: { effectiveMode: string; mode: string } }> };
    assert.equal(validated.instances[0]?.security.mode, "workspace");
    assert.equal(config.instances[0]?.security.mode, "disabled");

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: {
            approvalPolicy: { mode: "ask" },
            security: { mode: "workspace" }
        }
    });
    assert.equal(writes.length, 1);
    assert.equal(config.instances[0]?.security.mode, "workspace");
    assert.equal(registry.get("demo-local")?.worker.snapshot().effectiveSecurityMode, "workspace");

    await service.updateMcpConfig({
        patch: {
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 17891,
            publicBaseUrl: "http://127.0.0.1:17891"
        }
    });
    await service.updateWebConfig({
        patch: { enabled: true, listenHost: "127.0.0.1", listenPort: 17892, publicBaseUrl: "127.0.0.1" }
    });
    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: { mcp: { auth: "token", token: "0123456789abcdef0123456789abcdef" } }
    });

    const applied = service.applyConfig() as {
        affectedInstances: string[];
        affectedListeners: string[];
        affectedMcpEndpoints: string[];
        appliedChanges: Array<{ kind: string; target: string }>;
        reloadRequired: boolean;
        restartControlRequired: boolean;
    };
    assert.deepEqual(applied.appliedChanges, [
        { kind: "instance.updated", target: "demo-local" },
        { kind: "mcp.endpoint.updated", target: "mcp" },
        { kind: "web.updated", target: "web" },
        { kind: "instance.updated", target: "demo-local" }
    ]);
    assert.deepEqual(applied.affectedInstances, ["demo-local"]);
    assert.deepEqual(applied.affectedListeners, ["127.0.0.1:17890", "127.0.0.1:17891", "127.0.0.1:17892"]);
    assert.deepEqual(applied.affectedMcpEndpoints, ["/demo-local/mcp", "mcp"]);
    assert.equal(applied.reloadRequired, true);
    assert.equal(applied.restartControlRequired, true);
    assert.deepEqual(service.applyConfig(), { ...emptyApplyResult(), affectedListeners: [] });
});

test("listener preflight rejects an occupied Web bind without persisting configuration", async () => {
    let config = createConfig();
    const writes: ControlConfig[] = [];
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    assert.ok(typeof address === "object" && address !== null);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(nextConfig);
                config = nextConfig;
            }
        },
        getConfig: () => config,
        instanceRegistry: new InstanceRegistryFactory().build(config),
        setConfig: (nextConfig) => {
            config = nextConfig;
        }
    });

    try {
        await assert.rejects(
            service.updateWebConfig({
                patch: { enabled: true, listenHost: "127.0.0.1", listenPort: address.port }
            }),
            /Cannot bind HTTP listener 127\.0\.0\.1:/u
        );
        assert.equal(writes.length, 0);
        assert.equal(config.web.listenPort, 17890);
    } finally {
        await new Promise<void>((resolve, reject) => occupied.close((error) => error === undefined ? resolve() : reject(error)));
    }
});

test("listener preflight does not treat a disabled MCP endpoint as active", async () => {
    let config = createConfig();
    config.mcp.enabled = false;
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
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
        }
    });

    try {
        await assert.rejects(
            service.updateWebConfig({ patch: { enabled: true } }),
            /Cannot bind HTTP listener 127\.0\.0\.1:/u
        );
        assert.equal(config.web.enabled, false);
    } finally {
        await new Promise<void>((resolve, reject) => occupied.close((error) => error === undefined ? resolve() : reject(error)));
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
            }
        },
        getConfig: () => config,
        instanceRegistry: new InstanceRegistryFactory().build(config),
        runtimeApply: {
            async apply() {
                throw new Error("new listener did not become healthy");
            }
        },
        setConfig: (nextConfig) => {
            config = nextConfig;
        }
    });

    await assert.rejects(
        service.updateWebConfig({ patch: { enabled: true, listenPort: 17891 } }),
        /new listener did not become healthy/u
    );
    assert.equal(writes.length, 2);
    assert.equal(writes[0]?.web.listenPort, 17891);
    assert.equal(writes[1]?.web.listenPort, 17890);
    assert.equal(config.web.listenPort, 17890);
});

test("namespace auth updates restart the HTTP runtime before exposing OAuth", async () => {
    let config = createConfig();
    let applyCalls = 0;
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                config = nextConfig;
            }
        },
        getConfig: () => config,
        instanceRegistry: new InstanceRegistryFactory().build(config),
        runtimeApply: {
            async apply() {
                applyCalls += 1;
                return true;
            }
        },
        setConfig: (nextConfig) => {
            config = nextConfig;
        }
    });

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: {
            mcp: {
                auth: "oauth2",
                oauth2: { requiredScopes: ["mcp"], resourceName: "demo-local" }
            }
        }
    });
    assert.equal(applyCalls, 1);
});

test("config editor reconfigures and disables a running instance without replacing it", async () => {
    let config = createConfig();
    const reconfigureCalls: Array<Record<string, unknown>> = [];
    const registry = new InstanceRegistry([
        descriptor({
            reconfigure(input: Record<string, unknown>) {
                reconfigureCalls.push(input);
            },
            snapshot: runningSnapshot
        })
    ]);
    const service = createService(() => config, (next) => {
        config = next;
    }, registry);

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: {
            approvalPolicy: { mode: "ask" },
            security: { mode: "workspace" }
        }
    });
    await service.disableInstance({ instanceName: "demo-local" });

    assert.equal(config.instances[0]?.enabled, false);
    assert.equal(config.instances[0]?.security.mode, "workspace");
    assert.equal(reconfigureCalls.length, 1);
    assert.deepEqual(reconfigureCalls[0], {
        approvalPolicy: { mode: "ask", rules: undefined },
        defaultWorkspace: "/tmp/demo",
        effectiveSecurityMode: "workspace",
        env: {
            DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: "workspace",
            DEVSHELL_WORKER_SECURITY_MODE: "workspace"
        }
    });
    assert.equal(registry.get("demo-local")?.enabled, false);
});

test("config editor rejects delete and rebuild patches while an instance is running before persistence", async () => {
    let config = createConfig();
    const writes: unknown[] = [];
    const registry = new InstanceRegistry([descriptor({ snapshot: runningSnapshot })]);
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                writes.push(nextConfig);
                config = nextConfig;
            }
        },
        getConfig: () => config,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        }
    });

    await assert.rejects(service.deleteInstance({ instanceName: "demo-local" }), hasCode("instance.conflict"));
    await assert.rejects(
        service.updateInstanceConfig({
            instanceName: "demo-local",
            patch: { tools: { scheduler: { maxRunning: 2 } } }
        }),
        hasCode("instance.conflict")
    );
    assert.equal(writes.length, 0);
    assert.equal(config.instances[0]?.tools, undefined);
});

test("config editor reconciles instance MCP bindings from patches without restarting control", async () => {
    let config = createConfig();
    const registry = new InstanceRegistryFactory().build(config);
    const registered: Array<Record<string, unknown>> = [];
    const unregistered: string[] = [];
    const gateway = {} as never;
    const host = {
        registerInstance(instance: Record<string, unknown>) {
            registered.push(instance);
        },
        unregisterInstance(instanceName: string) {
            unregistered.push(instanceName);
        }
    };
    const service = new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                config = nextConfig;
            }
        },
        getConfig: () => config,
        getMcpHost: () => host as never,
        getMcpInstanceGateway: () => gateway,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        }
    });

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: {
            mcp: {
                tools: {
                    capabilities: ["read", "write", "execute", "manage"],
                    groups: ["file", "bash", "artifact", "instance"]
                }
            }
        }
    });

    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.gateway, gateway);
    assert.deepEqual(registered[0]?.policy, {
        capabilities: ["read", "write", "execute", "manage"],
        groups: ["file", "bash", "artifact", "instance"]
    });
    assert.deepEqual(registered[0]?.auth, { enabled: false, provider: "none" });

    await service.updateInstanceConfig({
        instanceName: "demo-local",
        patch: { mcp: { auth: "token", token: "0123456789abcdef0123456789abcdef" } }
    });
    assert.deepEqual(registered[1]?.auth, {
        enabled: true,
        provider: "token",
        token: "0123456789abcdef0123456789abcdef"
    });
    assert.deepEqual(service.applyConfig(), {
        affectedInstances: ["demo-local"],
        affectedListeners: [],
        affectedMcpEndpoints: ["/demo-local/mcp"],
        appliedChanges: [
            { kind: "instance.updated", target: "demo-local" },
            { kind: "instance.updated", target: "demo-local" }
        ],
        reloadRequired: true,
        restartControlRequired: false
    });

    await service.disableInstance({ instanceName: "demo-local" });
    assert.deepEqual(unregistered, ["demo-local"]);
    await service.enableInstance({ instanceName: "demo-local" });
    assert.equal(registered.length, 3);
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
                tools: {
                    capabilities: ["read", "write", "execute"],
                    groups: ["file", "bash", "artifact"]
                }
            },
            name: "demo-local",
            provider: "local",
            security: { mode: "disabled" },
            workspace: "/tmp/demo"
        })
    ];
    return config;
}

function createService(
    getConfig: () => ReturnType<typeof createConfig>,
    setConfig: (config: ReturnType<typeof createConfig>) => void,
    registry: InstanceRegistry
): ConfigEditorCoordinator {
    return new ConfigEditorCoordinator({
        configStore: {
            async write(nextConfig: ControlConfig) {
                setConfig(nextConfig);
            }
        },
        getConfig,
        instanceRegistry: registry,
        setConfig
    });
}

function descriptor(worker: Record<string, unknown>) {
    return {
        tools: { capabilities: ["read", "write", "execute"] as const, groups: ["file", "bash", "artifact"] },
        enabled: true,
        mcpEnabled: true,
        mcpPath: "/demo-local/mcp",
        name: "demo-local",
        worker
    } as never;
}

function runningSnapshot() {
    return {
        connectionState: "connected",
        daemonState: "running",
        effectiveSecurityMode: "disabled",
        lastSeq: 0,
        name: "demo-local",
        ready: true,
        status: "ready"
    };
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
        restartControlRequired: false
    };
}
