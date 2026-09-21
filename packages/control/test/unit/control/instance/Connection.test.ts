import assert from "node:assert/strict";
import test from "node:test";

import { InstanceConnectionService } from "../../../../src/control/instance/registry/Connection.ts";
import { InstanceRegistry } from "../../../../src/control/instance/registry/Registry.ts";
import type { InstanceDescriptor } from "../../../../src/control/instance/Descriptor.ts";

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
    const firstDescriptor = {
        enabled: true,
        name: "worker-a",
        worker: first,
    } as never;
    const secondDescriptor = {
        enabled: true,
        name: "worker-a",
        worker: second,
    } as never;
    const registry = new InstanceRegistry([firstDescriptor]);
    const connections = new InstanceConnectionService(registry);

    await connections.acquire("worker-a", "ctx:first");
    await registry.retireGeneration("worker-a", firstDescriptor);
    registry.add(secondDescriptor);
    await connections.acquire("worker-a", "ctx:second");

    await connections.release("worker-a", "ctx:first");
    assert.deepEqual(stopped, ["first"]);
    assert.equal(second.snapshot().ready, true);

    await connections.release("worker-a", "ctx:second");
    assert.deepEqual(stopped, ["first", "second"]);
});

test("retiring committed generation references allows the same Context to attach to the replacement", async () => {
    const worker = (): InstanceDescriptor["worker"] => ({
        managementMode: "controllerManaged" as const,
        snapshot() {
            return { daemonState: "running", ready: true };
        },
        async stop() {
            return { daemonState: "stopped", ready: false };
        },
    }) as InstanceDescriptor["worker"];
    const first = worker();
    const second = worker();
    const firstDescriptor = {
        enabled: true,
        name: "worker-a",
        worker: first,
    } as never;
    const secondDescriptor = {
        enabled: true,
        name: "worker-a",
        worker: second,
    } as never;
    const registry = new InstanceRegistry([firstDescriptor]);
    const connections = new InstanceConnectionService(registry);

    await connections.acquire("worker-a", "ctx:same");
    await registry.retireGeneration("worker-a", firstDescriptor);
    registry.add(secondDescriptor);
    registry.retireConnectionReferences("worker-a", first);

    const replacement = await connections.acquire("worker-a", "ctx:same");
    assert.equal(replacement.worker, second);
});

test("instance connection rejects a late acquire after its generation is retired", async () => {
    let ready = false;
    let signalStart!: () => void;
    let finishStart!: () => void;
    let stops = 0;
    const startEntered = new Promise<void>((resolve) => {
        signalStart = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
        finishStart = resolve;
    });
    const descriptor = {
        enabled: true,
        name: "worker-a",
        worker: {
            managementMode: "controllerManaged" as const,
            snapshot() {
                return {
                    daemonState: ready ? "running" : "stopped",
                    ready,
                };
            },
            async start() {
                signalStart();
                await startGate;
                ready = true;
                return { daemonState: "running", ready: true };
            },
            async stop() {
                stops += 1;
                ready = false;
                return { daemonState: "stopped", ready: false };
            },
        },
    } as never;
    const registry = new InstanceRegistry([descriptor]);
    const connections = new InstanceConnectionService(registry);

    const acquire = connections.acquire("worker-a", "ctx:late");
    await startEntered;
    let retired = false;
    const retirement = registry
        .retireGeneration("worker-a", descriptor)
        .then(() => {
            retired = true;
        });

    assert.equal(registry.get("worker-a"), undefined);
    await Promise.resolve();
    assert.equal(retired, false);

    finishStart();
    await assert.rejects(
        acquire,
        (error: unknown) =>
            (error as { code?: string }).code === "instance.conflict",
    );
    await retirement;

    assert.equal(stops, 1);
    assert.equal(
        registry.releaseConnectionReference("worker-a", "ctx:late"),
        undefined,
    );
});
