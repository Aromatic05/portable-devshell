import assert from "node:assert/strict";
import test from "node:test";

import { Instance } from "../../../src/instance/Instance.ts";
import type { WorkerInstance } from "../../../src/instance/runtime/index.ts";

function instance(worker: object): Instance {
    return new Instance({
        enabled: true,
        mcpEnabled: true,
        mcpPath: "/worker-a/mcp",
        modelExtensions: [],
        name: "worker-a",
        provider: "local",
        worker: worker as unknown as WorkerInstance,
    });
}

test("instance shares one managed Worker across MCP and Agent references", async () => {
    let ready = false;
    let starts = 0;
    let stops = 0;
    const worker = {
        managementMode: "controllerManaged",
        snapshot() {
            return { daemonState: ready ? "running" : "stopped", ready };
        },
        async start() {
            starts += 1;
            ready = true;
            return { daemonState: "running", ready };
        },
        async stop() {
            stops += 1;
            ready = false;
            return { daemonState: "stopped", ready };
        },
    };
    const current = instance(worker);

    const mcp = await current.acquireReference("ctx:mcp");
    const agent = await current.acquireReference("agent:ag-1");

    assert.equal(starts, 1);
    assert.equal(mcp.worker, agent.worker);
    await current.releaseReference("ctx:mcp");
    assert.equal(stops, 0);
    await current.releaseReference("agent:ag-1");
    assert.equal(stops, 1);
});

test("instance references keep an owned Worker running until the final release", async () => {
    let ready = false;
    let stops = 0;
    const current = instance({
        managementMode: "controllerManaged",
        snapshot() {
            return { daemonState: ready ? "running" : "stopped", ready };
        },
        async start() {
            ready = true;
            return { daemonState: "running", ready };
        },
        async stop() {
            stops += 1;
            ready = false;
            return { daemonState: "stopped", ready };
        },
    });

    await current.acquireReference("ctx:first");
    await current.acquireReference("ctx:second");
    await current.releaseReference("ctx:first");
    assert.equal(stops, 0);
    assert.equal(ready, true);
    await current.releaseReference("ctx:second");
    assert.equal(stops, 1);
    assert.equal(ready, false);
});

test("self-managed instance references never stop the externally owned Worker", async () => {
    let stops = 0;
    const current = instance({
        managementMode: "selfManaged",
        snapshot() {
            return { daemonState: "running", ready: true };
        },
        async refreshStatus() {
            return { daemonState: "running", ready: true };
        },
        async stop() {
            stops += 1;
            return { daemonState: "stopped", ready: false };
        },
    });

    await current.acquireReference("ctx:reverse");
    await current.releaseReference("ctx:reverse");

    assert.equal(stops, 0);
});

test("retiring an instance fences a pending acquire and stops its late start", async () => {
    let ready = false;
    let stops = 0;
    let enterStart!: () => void;
    let finishStart!: () => void;
    const startEntered = new Promise<void>((resolve) => {
        enterStart = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
        finishStart = resolve;
    });
    const current = instance({
        managementMode: "controllerManaged",
        snapshot() {
            return { daemonState: ready ? "running" : "stopped", ready };
        },
        async start() {
            enterStart();
            await startGate;
            ready = true;
            return { daemonState: "running", ready };
        },
        async stop() {
            stops += 1;
            ready = false;
            return { daemonState: "stopped", ready };
        },
    });

    const acquire = current.acquireReference("ctx:late");
    await startEntered;
    const retirement = current.retire();
    finishStart();

    await assert.rejects(acquire, (error: unknown) =>
        (error as { code?: string }).code === "instance.conflict",
    );
    await retirement;
    assert.equal(stops, 1);
    assert.equal(ready, false);
    assert.equal(current.retired, true);
});
