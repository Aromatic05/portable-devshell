import assert from "node:assert/strict";
import test from "node:test";

import { InstanceConnectionService } from "../../src/control/instance/connection/InstanceConnectionService.ts";
import { InstanceRegistry } from "../../src/control/instance/registry/InstanceRegistry.ts";

test("instance connection service shares one managed Worker across MCP and Agent references", async () => {
    let ready = false;
    let starts = 0;
    let stops = 0;
    const handle = { marker: "shared-worker-handle" };
    const registry = new InstanceRegistry([{
        enabled: true,
        name: "worker-a",
        worker: {
            get handle() { return handle; },
            managementMode: "controllerManaged",
            snapshot() { return { ready }; },
            async start() {
                starts += 1;
                ready = true;
                return { ready: true };
            },
            async stop() {
                stops += 1;
                ready = false;
                return { ready: false };
            }
        }
    } as never]);
    const connections = new InstanceConnectionService(registry);

    const mcp = await connections.acquire("worker-a", "ctx:mcp");
    const agent = await connections.acquire("worker-a", "agent:ag-1");

    assert.equal(starts, 1);
    assert.equal(mcp.handle, handle);
    assert.equal(agent.handle, handle);

    await connections.release("worker-a", "ctx:mcp");
    assert.equal(stops, 0);
    await connections.release("worker-a", "agent:ag-1");
    assert.equal(stops, 1);
});
