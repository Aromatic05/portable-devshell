import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import { createInstanceRuntimeRegistry } from "../../../../src/instance/index.ts";
import { createToolCallRegistry } from "../../../../src/toolcall/index.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

test("finalize retries a failed worker close without reopening the retired generation", async (t) => {
    const root = await createTestTempDirectory("instance-finalize-retry");
    const registry = createInstanceRuntimeRegistry({ homeDirectory: root, toolCalls: createToolCallRegistry() });
    t.after(async () => {
        await registry.close();
        await rm(root, { force: true, recursive: true });
    });
    const instance = registry.create(normalizeConfigInstanceDraft({ name: "retry-local", provider: "local" }));
    const runtime = registry.get(instance);
    const originalClose = instance.worker.close.bind(instance.worker);
    const failure = new Error("temporary close failure");
    instance.worker.close = async () => { throw failure; };
    await assert.rejects(registry.finalize(instance), AggregateError);
    assert.equal(instance.retired, true);
    assert.throws(() => instance.acquireLease(), /retired/u);
    assert.equal(registry.get(instance), runtime);

    instance.worker.close = originalClose;
    await registry.finalize(instance);
    assert.throws(() => registry.get(instance), /unavailable/u);
});

test("shutdown waits for admitted work and closes every instance audit", { timeout: 5000 }, async (t) => {
    const root = await createTestTempDirectory("instance-shutdown-drain");
    const registry = createInstanceRuntimeRegistry({ homeDirectory: root, toolCalls: createToolCallRegistry() });
    let releaseLease = () => {};
    t.after(async () => {
        releaseLease();
        await registry.close();
        await rm(root, { force: true, recursive: true });
    });
    const first = registry.create(normalizeConfigInstanceDraft({ name: "first-local", provider: "local" }));
    const second = registry.create(normalizeConfigInstanceDraft({ name: "second-local", provider: "local" }));
    const firstRuntime = registry.get(first);
    const secondRuntime = registry.get(second);
    await first.worker.appendControlEvent("test.shutdown", { value: 1 });
    assert.equal(firstRuntime.audit.api.events.readHighWater(), 1);
    const lease = first.acquireLease();
    releaseLease = () => lease.release();
    let closed = false;
    const closing = registry.close().then(() => { closed = true; });
    await firstRuntime.prepareRetirement();
    assert.equal(first.retired, true);
    assert.equal(closed, false);
    assert.throws(() => first.acquireLease(), /retired/u);
    lease.release();
    await closing;
    assert.equal(second.retired, true);
    assert.throws(() => firstRuntime.audit.api.events.readHighWater(), /closed/iu);
    assert.throws(() => secondRuntime.audit.api.events.readHighWater(), /closed/iu);
});

test("retirement cancels a pending approval before waiting for its admitted call", { timeout: 5000 }, async (t) => {
    const root = await createTestTempDirectory("instance-approval-drain");
    const registry = createInstanceRuntimeRegistry({ homeDirectory: root, toolCalls: createToolCallRegistry() });
    const instance = registry.create(normalizeConfigInstanceDraft({
        name: "approval-local", provider: "local", approvalPolicy: { mode: "ask" },
    }));
    const lease = instance.acquireLease();
    t.after(async () => {
        lease.release();
        await registry.close();
        await rm(root, { force: true, recursive: true });
    });
    const runtime = registry.get(instance);
    const evaluation = await runtime.approval.api.evaluate({
        callId: "pending-call", source: "mcp", inputSummary: "{}", toolName: "shell_run",
    });
    assert.equal(evaluation.decision, "ask");
    assert.ok("awaitDecision" in evaluation);
    const completedCall = evaluation.awaitDecision.then(resolution => {
        assert.equal(resolution.status, "cancelled");
        lease.release();
    });
    await registry.close();
    await completedCall;
    assert.equal(instance.retired, true);
    assert.throws(() => runtime.audit.api.events.readHighWater(), /closed/iu);
});

test("instance generations resume the persisted event cursor after finalization", async (t) => {
    const root = await createTestTempDirectory("instance-event-generation");
    const registry = createInstanceRuntimeRegistry({ homeDirectory: root, toolCalls: createToolCallRegistry() });
    t.after(async () => {
        await registry.close();
        await rm(root, { force: true, recursive: true });
    });
    const config = normalizeConfigInstanceDraft({ name: "event-local", provider: "local" });
    const original = registry.create(config);
    await original.worker.appendControlEvent("test.first", { value: 1 });
    await registry.finalize(original);
    const replacement = registry.create(config);
    assert.equal(replacement.worker.snapshot().lastSeq, 1);
    await replacement.worker.appendControlEvent("test.second", { value: 2 });
    const slice = replacement.worker.subscribe(1);
    assert.equal(slice.kind, "events");
    assert.ok("events" in slice);
    assert.deepEqual(slice.events.map(event => ({ seq: event.seq, type: event.type, data: event.data })), [
        { seq: 1, type: "test.first", data: { value: 1 } },
        { seq: 2, type: "test.second", data: { value: 2 } },
    ]);
});
