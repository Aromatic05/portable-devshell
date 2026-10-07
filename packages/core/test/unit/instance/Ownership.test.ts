import assert from "node:assert/strict";
import test from "node:test";

import { WorkerOwnership } from "../../../src/instance/runtime/supervision/Ownership.ts";

function createOwnership() {
    let active = true;
    let enabled = true;
    let ready = false;
    let starts = 0;
    let stops = 0;
    const lifecycle = {
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
    const ownership = new WorkerOwnership({
        admission: {
            active: () => active,
            enabled: () => enabled,
        },
        instanceName: "worker-a",
        lifecycle: lifecycle as never,
        managementMode: "controllerManaged",
        recovery: {} as never,
        snapshot: () =>
            ({ daemonState: ready ? "running" : "stopped", ready }) as never,
    });
    return {
        ownership,
        get starts() {
            return starts;
        },
        get stops() {
            return stops;
        },
        setActive(value: boolean) {
            active = value;
        },
        setEnabled(value: boolean) {
            enabled = value;
        },
    };
}

test("worker ownership auto-stops after the final reference", async () => {
    const current = createOwnership();

    await current.ownership.acquireReference("ctx:first");
    await current.ownership.acquireReference("ctx:second");

    assert.equal(current.starts, 1);
    assert.equal(current.ownership.owned, true);

    await current.ownership.releaseReference("ctx:first");
    assert.equal(current.stops, 0);

    await current.ownership.releaseReference("ctx:second");
    assert.equal(current.stops, 1);
    assert.equal(current.ownership.owned, false);
});

test("explicit worker ownership prevents reference release from stopping it", async () => {
    const current = createOwnership();

    await current.ownership.acquireReference("ctx:first");
    current.ownership.markOwned();
    await current.ownership.releaseReference("ctx:first");

    assert.equal(current.stops, 0);
    assert.equal(current.ownership.owned, true);

    current.ownership.clearOwned();
    assert.equal(current.ownership.owned, false);
});

test("worker ownership rejects a reference when the instance is disabled", async () => {
    const current = createOwnership();
    current.setEnabled(false);

    await assert.rejects(
        current.ownership.acquireReference("ctx:disabled"),
        (error: unknown) =>
            (error as { code?: string }).code === "instance.conflict",
    );
    assert.equal(current.starts, 0);
});

test("worker ownership stops a late start when instance retirement begins", async () => {
    let active = true;
    let ready = false;
    let starts = 0;
    let stops = 0;
    let finishStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
        finishStart = resolve;
    });
    const ownership = new WorkerOwnership({
        admission: {
            active: () => active,
            enabled: () => true,
        },
        instanceName: "worker-a",
        lifecycle: {
            async start() {
                starts += 1;
                await startGate;
                ready = true;
                return { daemonState: "running", ready };
            },
            async stop() {
                stops += 1;
                ready = false;
                return { daemonState: "stopped", ready };
            },
        } as never,
        managementMode: "controllerManaged",
        recovery: {} as never,
        snapshot: () =>
            ({ daemonState: ready ? "running" : "stopped", ready }) as never,
    });

    const acquiring = ownership.acquireReference("ctx:late");
    await Promise.resolve();
    active = false;
    finishStart();

    await assert.rejects(
        acquiring,
        (error: unknown) =>
            (error as { code?: string }).code === "instance.conflict",
    );
    assert.equal(starts, 1);
    assert.equal(stops, 1);
    assert.equal(ownership.owned, false);
});
