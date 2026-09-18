import assert from "node:assert/strict";
import test from "node:test";

import { InstanceConnectionService } from "../../../../src/control/instance/registry/Connection.ts";
import { InstanceRegistry } from "../../../../src/control/instance/registry/Registry.ts";

test("instance connection service shares one managed Worker across MCP and Agent references", async () => {
    let ready = false;
    let starts = 0;
    let stops = 0;
    const registry = new InstanceRegistry([
        {
            enabled: true,
            name: "worker-a",
            worker: {
                managementMode: "controllerManaged",
                snapshot() {
                    return { ready };
                },
                async start() {
                    starts += 1;
                    ready = true;
                    return { ready: true };
                },
                async stop() {
                    stops += 1;
                    ready = false;
                    return { ready: false };
                },
            },
        } as never,
    ]);
    const connections = new InstanceConnectionService(registry);

    const mcp = await connections.acquire("worker-a", "ctx:mcp");
    const agent = await connections.acquire("worker-a", "agent:ag-1");

    assert.equal(starts, 1);
    assert.equal(mcp.worker, agent.worker);

    await connections.release("worker-a", "ctx:mcp");
    assert.equal(stops, 0);
    await connections.release("worker-a", "agent:ag-1");
    assert.equal(stops, 1);
});

test("instance connection references remain bound to the Worker generation they acquired", async () => {
    const stopped: string[] = [];
    const worker = (generation: string) => {
        let ready = false;
        return {
            managementMode: "controllerManaged" as const,
            snapshot() {
                return {
                    daemonState: ready ? "running" : "stopped",
                    ready,
                };
            },
            async start() {
                ready = true;
                return { daemonState: "running", ready: true };
            },
            async stop() {
                stopped.push(generation);
                ready = false;
                return { daemonState: "stopped", ready: false };
            },
        };
    };
    const first = worker("first");
    const second = worker("second");
    const registry = new InstanceRegistry([
        {
            enabled: true,
            name: "worker-a",
            worker: first,
        } as never,
    ]);
    const connections = new InstanceConnectionService(registry);

    await connections.acquire("worker-a", "ctx:first");
    registry.update({
        enabled: true,
        name: "worker-a",
        worker: second,
    } as never);
    await connections.acquire("worker-a", "ctx:second");

    await connections.release("worker-a", "ctx:first");
    assert.deepEqual(stopped, ["first"]);
    assert.equal(second.snapshot().ready, true);

    await connections.release("worker-a", "ctx:second");
    assert.deepEqual(stopped, ["first", "second"]);
});
