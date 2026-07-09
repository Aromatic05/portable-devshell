import assert from "node:assert/strict";
import test from "node:test";

import {
    ControlConfigEditorService,
    InstanceRegistry,
    InstanceRegistryBuilder,
    createDefaultControlConfig
} from "../../dist/index.js";

test("config editor updates instance config, exposes effective security mode, and reports apply summary", async () => {
    let config = createConfig();
    const registry = new InstanceRegistryBuilder().build(config);
    const writes: unknown[] = [];
    const service = new ControlConfigEditorService({
        configStore: {
            async write(nextConfig: unknown) {
                writes.push(nextConfig);
                config = nextConfig as typeof config;
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

    const validated = service.validateConfigDraft({
        ...view,
        instances: [
            {
                ...config.instances[0],
                approvalPolicy: {
                    mode: "ask"
                },
                mcp: {
                    allowTools: ["bash_run", "read_file"],
                    enabled: true,
                    path: "/demo-local/mcp"
                },
                security: {
                    mode: "workspace"
                }
            }
        ]
    }) as { instances: Array<{ security: { effectiveMode: string; mode: string } }> };
    assert.equal(validated.instances[0]?.security.mode, "workspace");
    assert.equal(config.instances[0]?.security?.mode, "disabled");

    await service.updateInstanceConfig({
        ...config.instances[0],
        approvalPolicy: {
            mode: "ask"
        },
        mcp: {
            allowTools: ["bash_run", "read_file"],
            enabled: true,
            path: "/demo-local/mcp"
        },
        security: {
            mode: "workspace"
        }
    });

    assert.equal(writes.length, 1);
    assert.equal(config.instances[0]?.security?.mode, "workspace");
    assert.equal(config.instances[0]?.approvalPolicy?.mode, "ask");
    assert.equal(registry.get("demo-local")?.worker.snapshot().effectiveSecurityMode, "workspace");

    const applied = service.applyConfig() as {
        affectedInstances: string[];
        affectedMcpEndpoints: string[];
        appliedChanges: Array<{ kind: string; target: string }>;
        reloadRequired: boolean;
        restartControlRequired: boolean;
    };
    assert.deepEqual(applied.appliedChanges, [{ kind: "instance.updated", target: "demo-local" }]);
    assert.deepEqual(applied.affectedInstances, ["demo-local"]);
    assert.deepEqual(applied.affectedMcpEndpoints, ["/demo-local/mcp"]);
    assert.equal(applied.reloadRequired, true);
    assert.equal(applied.restartControlRequired, true);
    assert.deepEqual(service.applyConfig(), {
        affectedInstances: [],
        affectedMcpEndpoints: [],
        appliedChanges: [],
        reloadRequired: false,
        restartControlRequired: false
    });
});

test("config editor refuses deleting a running instance", async () => {
    let config = createConfig();
    const registry = new InstanceRegistry([
        {
            allowTools: ["bash_run"],
            mcpEnabled: true,
            mcpPath: "/demo-local/mcp",
            name: "demo-local",
            worker: {
                snapshot() {
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
            }
        }
    ]);
    const service = new ControlConfigEditorService({
        configStore: {
            async write(nextConfig: unknown) {
                config = nextConfig as typeof config;
            }
        },
        getConfig: () => config,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        }
    });

    await assert.rejects(service.deleteInstance({ instanceName: "demo-local" }), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "instance.conflict");
        return true;
    });
});

function createConfig() {
    return {
        ...createDefaultControlConfig(),
        instances: [
            {
                enabled: true,
                mcp: {
                    allowTools: ["bash_run"],
                    enabled: true,
                    path: "/demo-local/mcp"
                },
                name: "demo-local",
                provider: "local" as const,
                security: {
                    mode: "disabled"
                },
                workspace: "/tmp/demo"
            }
        ],
        mcp: {
            ...createDefaultControlConfig().mcp,
            enabled: true
        }
    };
}
