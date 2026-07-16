import assert from "node:assert/strict";
import test from "node:test";

import { InstanceRegistryFactory, McpEndpointFactory, McpRuntimeFactory, createDefaultControlConfig } from "../../dist/index.js";
import { normalizeConfigInstanceDraft } from "@portable-devshell/shared";

test("disabled instances are skipped and registry does not auto start workers", () => {
    const config = createDefaultControlConfig();

    config.instances.push(
        normalizeConfigInstanceDraft({
            enabled: true,
            mcp: { enabled: true, tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] } },
            name: "demo-local",
            provider: "local",
            workspace: "/tmp/demo"
        }),
        normalizeConfigInstanceDraft({
            enabled: false,
            mcp: { enabled: true, tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] } },
            name: "demo-disabled",
            provider: "local",
            workspace: "/tmp/disabled"
        })
    );
    config.mcp.enabled = true;

    const registry = new InstanceRegistryFactory().build(config);

    assert.equal(registry.list().length, 1);
    assert.equal(registry.get("demo-disabled"), undefined);
    assert.equal(registry.get("demo-local")?.worker.snapshot().ready, false);
});

test("mcp endpoint path is generated and wiring only builds host configuration", () => {
    const config = createDefaultControlConfig();
    config.mcp.enabled = true;
    config.instances.push(normalizeConfigInstanceDraft({
        enabled: true,
        mcp: { enabled: true, tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] } },
        name: "demo-local",
        provider: "local",
        workspace: "/tmp/demo"
    }));

    const registry = new InstanceRegistryFactory().build(config);
    const descriptor = registry.get("demo-local");

    assert.ok(descriptor !== undefined);
    assert.equal(descriptor.mcpPath, "/demo-local/mcp");
    assert.deepEqual(new McpEndpointFactory().map(descriptor), {
        policy: {
            capabilities: ["read", "write", "execute"],
            groups: ["file", "bash", "artifact"]
        },
        name: "demo-local",
        path: "/demo-local/mcp",
        worker: descriptor.worker
    });

    const host = new McpRuntimeFactory().wire(config, registry);

    assert.ok(host !== undefined);
    assert.ok(host.server);
    assert.equal(descriptor.worker.snapshot().ready, false);
});

test("stopOwned only stops workers started by this control and keeps failed ownership", async () => {
    const stopped: string[] = [];
    const registry = new (await import("../../dist/modules/instance/registry/InstanceRegistry.js")).InstanceRegistry([
        {
            tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] },
            enabled: true,
            mcpEnabled: false,
            mcpPath: "",
            name: "owned-ok",
            worker: {
                async stop() {
                    stopped.push("owned-ok");
                }
            } as never
        },
        {
            tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] },
            enabled: true,
            mcpEnabled: false,
            mcpPath: "",
            name: "owned-fail",
            worker: {
                async stop() {
                    stopped.push("owned-fail");
                    throw new Error("stop failed");
                }
            } as never
        },
        {
            tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] },
            enabled: true,
            mcpEnabled: false,
            mcpPath: "",
            name: "unowned",
            worker: {
                async stop() {
                    stopped.push("unowned");
                }
            } as never
        }
    ]);

    registry.markOwned("owned-ok");
    registry.markOwned("owned-fail");

    await assert.rejects(registry.stopOwned(), /Failed to stop 1 worker instance/u);
    assert.deepEqual(stopped, ["owned-ok", "owned-fail"]);

    stopped.length = 0;
    await assert.rejects(registry.stopOwned(), /Failed to stop 1 worker instance/u);
    assert.deepEqual(stopped, ["owned-fail"]);
});
