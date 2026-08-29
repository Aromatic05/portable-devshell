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

test("WaitState can detach a resolved result when its owner disappears after resolution", () => {
    const timestamps = [
        "2026-08-18T00:00:00.000Z",
        "2026-08-18T00:01:00.000Z",
        "2026-08-18T00:02:00.000Z",
    ];
    const state = new WaitState({
        now: () => timestamps.shift() ?? "2026-08-18T00:03:00.000Z",
        waitId: () => "wait-fixed",
    });
    const created = state.create(state.emptyDocument(), {
        createdByCtxId: "ctx-1",
        kind: "question",
        ownerCallId: "call-1",
        targetId: "question-1",
    });
    const resolved = state.resolve(created.document, created.record.waitId, { answer: "yes" });
    assert.equal(resolved.record.detachedAt, undefined);

    const detached = state.detach(resolved.document, created.record.waitId);
    assert.equal(detached.record.status, "resolved");
    assert.equal(detached.record.detachedAt, "2026-08-18T00:02:00.000Z");
    assert.deepEqual(detached.record.result, { answer: "yes" });
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

test("WaitState keeps resolved waits recoverable until model re-entry completes", () => {
    const state = new WaitState({ waitId: () => "wait-fixed" });
    const created = state.create(state.emptyDocument(), {
        createdByCtxId: "ctx-1",
        kind: "tmux",
        targetId: "tmux-task-1",
        taskId: "task-1",
    });
    const detached = state.detach(created.document, created.record.waitId);
    const resolved = state.resolve(detached.document, created.record.waitId, { exitCode: 0 });
    const claimed = state.claimRecovery(resolved.document, created.record.waitId, "claim-1");

    assert.equal(claimed.record.status, "resolved");
    assert.equal(claimed.record.recoveryClaimId, "claim-1");
    assert.match(claimed.record.recoveryMessageId ?? "", /^recovery-message-/u);
    const attempted = state.markRecoveryAttempted(claimed.document, created.record.waitId, "claim-1");
    const attemptedAgain = state.markRecoveryAttempted(attempted.document, created.record.waitId, "claim-1");
    assert.equal(attemptedAgain.record.recoveryMessageAttemptedAt, attempted.record.recoveryMessageAttemptedAt);
    const sent = state.markRecoverySent(attempted.document, created.record.waitId, "claim-1");
    const sentAgain = state.markRecoverySent(sent.document, created.record.waitId, "claim-1");
    assert.equal(sentAgain.record.recoveryMessageSentAt, sent.record.recoveryMessageSentAt);
    const sentTakeover = state.claimRecovery(sent.document, created.record.waitId, "claim-after-send");
    assert.equal(sentTakeover.record.recoveryClaimId, "claim-after-send");
    assert.equal(sentTakeover.record.recoveryMessageId, sent.record.recoveryMessageId);
    const sentCompleted = state.completeRecovery(sentTakeover.document, created.record.waitId, "claim-after-send");
    assert.equal(sentCompleted.record.status, "consumed");
    assert.throws(
        () => state.claimRecovery(claimed.document, created.record.waitId, "claim-2"),
        /already claimed/u,
    );

    const released = state.releaseRecovery(claimed.document, created.record.waitId, "claim-1");
    assert.equal(released.record.status, "resolved");
    assert.equal(released.record.recoveryClaimId, undefined);
    const reclaimed = state.claimRecovery(released.document, created.record.waitId, "claim-2");
    assert.throws(
        () => state.completeRecovery(reclaimed.document, created.record.waitId, "claim-2"),
        /not been durably marked sent/u,
    );
    const reattempted = state.markRecoveryAttempted(reclaimed.document, created.record.waitId, "claim-2");
    const resent = state.markRecoverySent(reattempted.document, created.record.waitId, "claim-2");
    const completed = state.completeRecovery(resent.document, created.record.waitId, "claim-2");
    assert.equal(completed.record.status, "consumed");
    assert.equal(completed.record.recoveryClaimId, undefined);
});

test("WaitState fences an ambiguous recovery delivery from automatic replay", () => {
    const state = new WaitState({ waitId: () => "wait-fixed" });
    const created = state.create(state.emptyDocument(), {
        createdByCtxId: "ctx-1",
        kind: "tmux",
        targetId: "tmux-task-1",
    });
    const detached = state.detach(created.document, created.record.waitId);
    const resolved = state.resolve(detached.document, created.record.waitId, { task: { status: "0" } });
    const claimed = state.claimRecovery(resolved.document, created.record.waitId, "claim-1");
    const attempted = state.markRecoveryAttempted(claimed.document, created.record.waitId, "claim-1");

    assert.throws(
        () => state.releaseRecovery(attempted.document, created.record.waitId, "claim-1"),
        /delivery is uncertain/u,
    );
    assert.throws(
        () => state.claimRecovery(attempted.document, created.record.waitId, "claim-2"),
        /automatic replay is disabled/u,
    );
    const dismissed = state.dismissRecovery(
        attempted.document,
        created.record.waitId,
        attempted.record.recoveryMessageId!,
    );
    assert.equal(dismissed.record.status, "consumed");
    assert.equal(typeof dismissed.record.recoveryDismissedAt, "string");
    assert.throws(
        () => state.dismissRecovery(attempted.document, created.record.waitId, "wrong-message"),
        /dismiss uncertain recovery/u,
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

test("WaitService reattaches durable ownership before waiting again", async () => {
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

    const reattached = await service.reattach(created.waitId, "call-2");
    assert.equal(reattached.status, "waiting");
    assert.equal(reattached.detachedAt, undefined);
    assert.equal(reattached.ownerCallId, "call-2");
    const resumed = service.waitForResolution(created.waitId);
    const result = { task: { id: "tmux-task-1", status: "0" } };
    await service.resolve(created.waitId, result);

    assert.deepEqual((await resumed).result, result);
});

test("WaitStore marks a resolved result recoverable when its in-process owner was lost", async () => {
    const root = await createTestTempDirectory("wait-store-resolved-");
    const filePath = join(root, "waits.json");
    const state = new WaitState({ waitId: () => "wait-resolved" });
    const store = new WaitStore({ filePath, instanceName: "aromatic-pc", state });
    const created = state.create(store.read(), {
        createdByCtxId: "ctx-1",
        kind: "tmux",
        ownerCallId: "call-1",
        targetId: "tmux-task-1",
    });
    const resolved = state.resolve(created.document, created.record.waitId, {
        task: { id: "tmux-task-1", status: "0" },
    });
    assert.equal(resolved.record.detachedAt, undefined);
    await store.write(resolved.document);

    const reloaded = new WaitStore({ filePath, instanceName: "aromatic-pc", state });
    const recovered = reloaded.read().waits[0];
    assert.equal(recovered?.status, "resolved");
    assert.equal(typeof recovered?.detachedAt, "string");
});

test("WaitService rejects a second in-process owner for the same wait", async () => {
    const root = await createTestTempDirectory("wait-service-owner-");
    const service = new WaitService({
        async appendEvent() {},
        filePath: join(root, "waits.json"),
        instanceName: "aromatic-pc",
    });
    const created = await service.create({
        createdByCtxId: "ctx-1",
        kind: "question",
        targetId: "question-1",
    });
    const owner = service.waitForResolution(created.waitId);

    await assert.rejects(
        service.waitForResolution(created.waitId),
        /already has an active in-process owner/u,
    );
    await service.cancel(created.waitId);
    await assert.rejects(owner, /became cancelled/u);
});
