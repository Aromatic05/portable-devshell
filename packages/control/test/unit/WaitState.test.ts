import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { WaitState } from "../../src/instance/wait/WaitState.ts";
import { WaitService } from "../../src/instance/wait/WaitService.ts";
import { WaitStore } from "../../src/instance/wait/WaitStore.ts";

test("WaitState preserves detach information through resolution and consumption", () => {
    const timestamps = [
        "2026-08-18T00:00:00.000Z",
        "2026-08-18T00:01:00.000Z",
        "2026-08-18T00:02:00.000Z",
        "2026-08-18T00:03:00.000Z",
    ];
    const state = new WaitState({
        now: () => timestamps.shift() ?? "2026-08-18T00:04:00.000Z",
        waitId: () => "wait-fixed",
    });
    const created = state.create(state.emptyDocument(), {
        createdByCtxId: "ctx-1",
        kind: "tmux",
        ownerCallId: "call-1",
        targetId: "tmux-task-1",
        taskId: "task-1",
    });

    assert.equal(created.record.status, "waiting");
    const detached = state.detach(created.document, created.record.waitId);
    assert.equal(detached.record.status, "detached");
    assert.equal(detached.record.detachedAt, "2026-08-18T00:01:00.000Z");

    const resolved = state.resolve(detached.document, created.record.waitId, { exitCode: 0 });
    assert.equal(resolved.record.status, "resolved");
    assert.equal(resolved.record.detachedAt, "2026-08-18T00:01:00.000Z");
    assert.deepEqual(resolved.record.result, { exitCode: 0 });

    const consumed = state.consume(resolved.document, created.record.waitId);
    assert.equal(consumed.record.status, "consumed");
    assert.equal(consumed.record.consumedAt, "2026-08-18T00:03:00.000Z");
});

test("WaitState cancels unresolved waits and rejects invalid transitions", () => {
    const state = new WaitState({ waitId: () => "wait-fixed" });
    const created = state.create(state.emptyDocument(), {
        createdByCtxId: "ctx-1",
        kind: "question",
        targetId: "question-1",
        taskId: "task-1",
    });
    const cancelled = state.cancel(created.document, created.record.waitId);

    assert.equal(cancelled.record.status, "cancelled");
    assert.throws(
        () => state.resolve(cancelled.document, created.record.waitId, "late answer"),
        /while it is cancelled/,
    );
});

test("WaitStore persists wait state atomically and detaches orphaned calls after restart", async () => {
    const root = await createTestTempDirectory("wait-store-");
    const filePath = join(root, "waits.json");
    const state = new WaitState({ waitId: () => "wait-fixed" });
    const store = new WaitStore({ filePath, instanceName: "aromatic-pc", state });
    const created = state.create(store.read(), {
        createdByCtxId: "ctx-1",
        kind: "approval",
        ownerCallId: "call-1",
        targetId: "approval-1",
        taskId: "task-1",
    });

    await store.write(created.document);
    const reloaded = new WaitStore({ filePath, instanceName: "aromatic-pc", state });
    const recovered = reloaded.read().waits[0];
    assert.equal(recovered?.status, "detached");
    assert.equal(typeof recovered?.detachedAt, "string");
    assert.equal(recovered?.ownerCallId, created.record.ownerCallId);
    assert.equal(recovered?.targetId, created.record.targetId);
});

test("WaitService lets a detached wait reattach until it resolves", async () => {
    const root = await createTestTempDirectory("wait-service-");
    const service = new WaitService({
        async appendEvent() {},
        filePath: join(root, "waits.json"),
        instanceName: "aromatic-pc",
    });
    const created = await service.create({
        createdByCtxId: "ctx-1",
        kind: "tmux",
        targetId: "tmux-task-1",
    });
    const first = service.waitForResolution(created.waitId);

    await service.detach(created.waitId);
    await assert.rejects(first, /became detached/u);

    const resumed = service.waitForResolution(created.waitId);
    const result = { task: { id: "tmux-task-1", status: "0" } };
    await service.resolve(created.waitId, result);

    assert.deepEqual((await resumed).result, result);
});
