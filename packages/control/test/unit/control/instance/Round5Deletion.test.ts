import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { inspect } from "node:util";
import test from "node:test";
import { ControlPathHome } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { deletionFixture, gate } from "./Round5DeletionFixture.ts";

async function home(t: test.TestContext) {
    const directory = await createTestTempDirectory("round5-deletion");
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

function capture(t: test.TestContext) {
    const warnings: string[] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(inspect(args, { depth: 12 })); });
    return warnings;
}

test("Round5 failed retirement commits deletion, retains identity and original cleanup log", async (t) => {
    const warnings = capture(t);
    const f = await deletionFixture(await home(t), { retireRuntime: async () => { throw new Error("round5 injected retire exit 23"); } });
    t.after(() => f.close());
    const result = await f.editor.deleteInstance({ instanceName: f.draft.name }) as Record<string, unknown>;
    assert.equal(result.cleanupPending, true);
    assert.equal(f.registry.get(f.draft.name), undefined);
    assert.deepEqual((await f.store.readOrCreate(f.home)).instances, []);
    const [debt] = await f.editor.listCleanupDebts();
    assert.ok(debt?.generationId);
    assert.match(debt.reason!, /round5 injected retire exit 23/);
    assert.match(warnings.join("\n"), /delete committed but cleanup was incomplete/);
    assert.match(warnings.join("\n"), /round5 injected retire exit 23/);
    await assert.rejects(f.editor.assertInstanceCleanupSettled(f.draft.name, false), { code: "instance.conflict" });
});

test("Round5 repeated failed retry after coordinator restart preserves generation and timestamp", async (t) => {
    capture(t);
    const directory = await home(t);
    const fail = async () => { throw new Error("round5 retained runtime failure"); };
    const first = await deletionFixture(directory, { retireRuntime: fail });
    t.after(() => first.close());
    await first.editor.deleteInstance({ instanceName: first.draft.name });
    const [before] = await first.editor.listCleanupDebts();
    await first.close();
    const second = await deletionFixture(directory, { retireRuntime: fail }, true);
    t.after(() => second.close());
    await second.editor.reconcileCleanupDebt(first.draft.name);
    await second.editor.reconcileCleanupDebt(first.draft.name);
    const [after] = await second.editor.listCleanupDebts();
    assert.equal(after!.generationId, before!.generationId);
    assert.equal(after!.createdAt, before!.createdAt);
    assert.equal(after!.state, "pending");
    assert.match(after!.reason!, /round5 retained runtime failure/);
    assert.equal(second.registry.get(first.draft.name), undefined);
});

test("Round5 user retry settles retained debt with already gone Worker and allows recreation", async (t) => {
    capture(t);
    const directory = await home(t);
    const first = await deletionFixture(directory, { retireRuntime: async () => { throw new Error("transient retire failure"); } });
    t.after(() => first.close());
    await first.editor.deleteInstance({ instanceName: first.draft.name });
    await first.close();
    let retireCalls = 0;
    const second = await deletionFixture(directory, { retireRuntime: async () => { retireCalls++; } }, true);
    t.after(() => second.close());
    await second.editor.reconcileCleanupDebt(first.draft.name);
    assert.equal(retireCalls, 1);
    assert.deepEqual(await second.editor.listCleanupDebts(), []);
    assert.deepEqual(JSON.parse(await readFile(new ControlPathHome(directory).lifecycleCleanupFile, "utf8")), []);
    await second.creator.createInstance(first.draft);
    assert.ok(second.registry.get(first.draft.name));
    assert.equal((await second.store.readOrCreate(directory)).instances[0]!.name, first.draft.name);
});

test("Round5 concurrent retries join one retirement and retain the name barrier", { timeout: 10000 }, async (t) => {
    capture(t);
    let fail = true;
    let calls = 0;
    const entered = gate();
    const release = gate();
    const f = await deletionFixture(await home(t), { retireRuntime: async () => {
        calls++;
        if (fail) throw new Error("initial debt");
        entered.resolve();
        await release.promise;
    } });
    t.after(async () => { release.resolve(); await f.close(); });
    await f.editor.deleteInstance({ instanceName: f.draft.name });
    fail = false;
    const retry = f.editor.reconcileCleanupDebt(f.draft.name);
    await entered.promise;
    const joined = f.editor.reconcileCleanupDebt(f.draft.name);
    await assert.rejects(f.editor.assertInstanceCleanupSettled(f.draft.name, false), { code: "instance.conflict" });
    assert.equal(calls, 2);
    release.resolve();
    await Promise.all([retry, joined]);
    assert.equal(calls, 2);
    assert.deepEqual(await f.editor.listCleanupDebts(), []);
});

test("Round5 blocked old cleanup does not hold global config lock for unrelated creation", { timeout: 10000 }, async (t) => {
    const entered = gate();
    const release = gate();
    const f = await deletionFixture(await home(t), { retireProviderResources: async () => { entered.resolve(); await release.promise; } });
    t.after(async () => { release.resolve(); await f.close(); });
    const deleting = f.editor.deleteInstance({ instanceName: f.draft.name });
    await entered.promise;
    try {
        await f.creator.createInstance({ name: "round5-unrelated", provider: "ssh", ssh: { command: "ssh round5.invalid" }, mcp: { enabled: false } });
        assert.ok(f.registry.get("round5-unrelated"));
        assert.equal(f.registry.get(f.draft.name), undefined);
        assert.equal((await f.editor.listCleanupDebts())[0]!.state, "pending");
    } finally { release.resolve(); await deleting; }
    assert.deepEqual(await f.editor.listCleanupDebts(), []);
});

test("Round5 provider cleanup still executes when runtime retirement fails", async (t) => {
    capture(t);
    const order: string[] = [];
    const f = await deletionFixture(await home(t), {
        retireRuntime: async () => { order.push("runtime"); throw new Error("runtime fault"); },
        retireProviderResources: async () => { order.push("provider"); },
    });
    t.after(() => f.close());
    await f.editor.deleteInstance({ instanceName: f.draft.name });
    assert.deepEqual(order, ["runtime", "provider"]);
    await f.editor.reconcileCleanupDebt(f.draft.name);
    assert.deepEqual(order, ["runtime", "provider", "runtime", "provider"]);
    assert.equal((await f.editor.listCleanupDebts()).length, 1);
});

test("Round5 cleanup hook failure survives runtime success and retry replays only removed generation", async (t) => {
    capture(t);
    let runtimeCalls = 0;
    const f = await deletionFixture(await home(t), { retireRuntime: async () => { runtimeCalls++; } });
    t.after(() => f.close());
    const unregister = f.editor.registerInstanceDeleteRetirement(async () => { throw new Error("round5 context deletion fault"); });
    const result = await f.editor.deleteInstance({ instanceName: f.draft.name }) as Record<string, unknown>;
    assert.equal(result.cleanupPending, true);
    assert.match((await f.editor.listCleanupDebts())[0]!.reason!, /round5 context deletion fault/);
    unregister();
    await f.editor.reconcileCleanupDebt(f.draft.name);
    assert.equal(runtimeCalls, 2);
    assert.deepEqual(await f.editor.listCleanupDebts(), []);
    assert.equal(f.registry.get(f.draft.name), undefined);
    assert.deepEqual((await f.store.readOrCreate(f.home)).instances, []);
});

test("Round5 canceled accepted stop releases its lease so deletion drains and retains failed Worker cleanup", { timeout: 10000 }, async (t) => {
    capture(t);
    const stopEntered = gate();
    const canceled = gate();
    let retirementCalls = 0;
    const f = await deletionFixture(await home(t), {
        stop: async () => { stopEntered.resolve(); await canceled.promise; throw new Error("round5 stop request canceled"); },
        retireRuntime: async () => { retirementCalls++; throw new Error("Worker still running after canceled stop"); },
    });
    const descriptor = f.registry.get(f.draft.name)!;
    const lease = descriptor.lifecycle.acquireLease();
    t.after(async () => { canceled.resolve(); lease.release(); await f.close(); });
    const stopping = descriptor.supervision.lifecycle.stop().finally(() => lease.release());
    const stopRejected = assert.rejects(stopping, /round5 stop request canceled/);
    await stopEntered.promise;
    const detached = gate();
    const originalDetach = f.registry.detach.bind(f.registry);
    t.mock.method(f.registry, "detach", (name: string, expected?: typeof descriptor, onRemoved?: () => void) => {
        const result = originalDetach(name, expected, onRemoved);
        detached.resolve();
        return result;
    });
    const deleting = f.editor.deleteInstance({ instanceName: f.draft.name });
    await detached.promise;
    assert.equal(descriptor.lifecycle.phase, "retiring");
    assert.equal(retirementCalls, 0);
    assert.equal(f.registry.get(f.draft.name), undefined);
    canceled.resolve();
    await stopRejected;
    const result = await deleting as Record<string, unknown>;
    assert.equal(result.cleanupPending, true);
    assert.equal(retirementCalls, 1);
    assert.equal((await f.editor.listCleanupDebts())[0]!.state, "pending");
});
