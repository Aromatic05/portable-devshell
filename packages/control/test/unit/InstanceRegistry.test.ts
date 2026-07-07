import assert from "node:assert/strict";
import test from "node:test";

import {
    ControlConfigTomlCodec,
    InstanceRegistryBuilder,
    McpEndpointConfigMapper,
    McpWiringService,
    createDefaultControlConfig
} from "../../dist/index.js";

test("disabled instances are skipped and registry does not auto start workers", () => {
    const config = new ControlConfigTomlCodec().decode(new ControlConfigTomlCodec().encode(createDefaultControlConfig()));

    config.instances.push(
        {
            enabled: true,
            mcp: {
                allowTools: ["bash_run"],
                enabled: true
            },
            name: "demo-local",
            provider: "local",
            workerBinaryPath: "/missing/devshell-worker"
        },
        {
            enabled: false,
            mcp: {
                allowTools: ["bash_run"],
                enabled: true
            },
            name: "demo-disabled",
            provider: "local"
        }
    );
    config.mcp.enabled = true;

    const registry = new InstanceRegistryBuilder().build(config);

    assert.equal(registry.list().length, 1);
    assert.equal(registry.get("demo-disabled"), undefined);
    assert.equal(registry.get("demo-local")?.worker.snapshot().ready, false);
});

test("mcp endpoint path is generated and wiring only builds host configuration", () => {
    const config = new ControlConfigTomlCodec().decode(new ControlConfigTomlCodec().encode(createDefaultControlConfig()));
    config.mcp.enabled = true;
    config.instances.push({
        enabled: true,
        mcp: {
            allowTools: ["bash_run"],
            enabled: true
        },
        name: "demo-local",
        provider: "local"
    });

    const registry = new InstanceRegistryBuilder().build(config);
    const descriptor = registry.get("demo-local");

    assert.ok(descriptor !== undefined);
    assert.equal(descriptor.mcpPath, "/demo-local/mcp");
    assert.deepEqual(new McpEndpointConfigMapper().map(descriptor), {
        allowlist: ["bash_run"],
        name: "demo-local",
        worker: descriptor.worker
    });

    const host = new McpWiringService().wire(config, registry);

    assert.ok(host !== undefined);
    assert.ok(host.server);
    assert.equal(descriptor.worker.snapshot().ready, false);
});
