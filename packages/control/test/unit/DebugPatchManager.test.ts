import assert from "node:assert/strict";
import test from "node:test";

import { DebugPatchManager } from "../../src/control/debug/DebugPatchManager.ts";

class DemoTarget {
    async run(value: string, signal?: AbortSignal): Promise<string> {
        if (signal?.aborted === true) throw signal.reason;
        return `original:${value}`;
    }
}

function register(manager: DebugPatchManager, target: DemoTarget): void {
    manager.registerTarget("demo", target, {
        run: {
            project: (args) => ({ value: String(args[0]) }),
            signal: (args) => args[1] instanceof AbortSignal ? args[1] : undefined,
        },
    });
}

test("DebugPatchManager loads and rolls back an instance method without changing its prototype", async () => {
    const manager = new DebugPatchManager();
    const target = new DemoTarget();
    const before = Object.getOwnPropertyDescriptor(target, "run");
    register(manager, target);

    const patch = await manager.load({
        source: `(event) => event.args.value === "patch"
            ? { action: "return", value: "patched" }
            : { action: "continue" }`,
        target: "demo",
    });

    assert.equal(await target.run("patch"), "patched");
    assert.equal(await target.run("pass"), "original:pass");
    assert.equal(manager.listPatches()[0]?.invocationCount, 2);

    await manager.unload(patch.patchId);
    assert.deepEqual(Object.getOwnPropertyDescriptor(target, "run"), before);
    assert.equal(await target.run("patch"), "original:patch");
    await manager.dispose();
});

test("DebugPatchManager auto-unloads a non-terminating program and continues the original method", async () => {
    const manager = new DebugPatchManager({ evaluationTimeoutMs: 25 });
    const target = new DemoTarget();
    register(manager, target);

    const patch = await manager.load({
        source: `() => { while (true) {} }`,
        target: "demo",
    });

    const startedAt = Date.now();
    assert.equal(await target.run("safe"), "original:safe");
    assert.ok(Date.now() - startedAt < 500, "debug worker cleanup blocked the original method");
    const record = manager.listPatches().find((entry) => entry.patchId === patch.patchId);
    assert.equal(record?.state, "faulted");
    assert.match(record?.fault ?? "", /timed out|timeout/iu);
    assert.equal(await target.run("again"), "original:again");
    await manager.dispose();
});

test("DebugPatchManager holds only the matched invocation and records host cancellation without unloading", async () => {
    const manager = new DebugPatchManager();
    const target = new DemoTarget();
    register(manager, target);

    const patch = await manager.load({
        source: `(event) => event.args.value === "hold"
            ? { action: "hold", label: "host-timeout-probe" }
            : { action: "continue" }`,
        target: "demo",
    });
    const controller = new AbortController();
    const pending = target.run("hold", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await target.run("other"), "original:other");
    controller.abort(new Error("host cancelled"));
    await assert.rejects(pending, /host cancelled/iu);

    const record = manager.listPatches().find((entry) => entry.patchId === patch.patchId);
    assert.equal(record?.state, "active");
    assert.equal(record?.lastInvocation?.outcome, "aborted");
    assert.equal(record?.lastInvocation?.label, "host-timeout-probe");
    assert.ok(record?.lastInvocation?.completedAt);

    await manager.unload(patch.patchId);
    await manager.dispose();
});
