import assert from "node:assert/strict";
import test from "node:test";

import { InstanceRegistryBuilder, McpEndpointConfigMapper, McpWiringService, createDefaultControlConfig } from "../../dist/index.js";

test("disabled instances are skipped and registry does not auto start workers", () => {
    const config = createDefaultControlConfig();

    config.instances.push(
        {
            enabled: true,
            mcp: {
                allowTools: ["bash_run"],
                enabled: true
            },
            name: "demo-local",
            provider: "local",
            workspace: "/tmp/demo"
        },
        {
            enabled: false,
            mcp: {
                allowTools: ["bash_run"],
                enabled: true
            },
            name: "demo-disabled",
            provider: "local",
            workspace: "/tmp/disabled"
        }
    );
    config.mcp.enabled = true;

    const registry = new InstanceRegistryBuilder().build(config);

    assert.equal(registry.list().length, 1);
    assert.equal(registry.get("demo-disabled"), undefined);
    assert.equal(registry.get("demo-local")?.worker.snapshot().ready, false);
});

test("mcp endpoint path is generated and wiring only builds host configuration", () => {
    const config = createDefaultControlConfig();
    config.mcp.enabled = true;
    config.instances.push({
        enabled: true,
        mcp: {
            allowTools: ["bash_run"],
            enabled: true
        },
        name: "demo-local",
        provider: "local",
        workspace: "/tmp/demo"
    });

    const registry = new InstanceRegistryBuilder().build(config);
    const descriptor = registry.get("demo-local");

    assert.ok(descriptor !== undefined);
    assert.equal(descriptor.mcpPath, "/demo-local/mcp");
    assert.deepEqual(new McpEndpointConfigMapper().map(descriptor), {
        allowlist: ["bash_run"],
        name: "demo-local",
        path: "/demo-local/mcp",
        worker: descriptor.worker
    });

    const host = new McpWiringService().wire(config, registry);

    assert.ok(host !== undefined);
    assert.ok(host.server);
    assert.equal(descriptor.worker.snapshot().ready, false);
});
