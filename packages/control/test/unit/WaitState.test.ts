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

test("WaitState atomically consumes a detached completion without consuming a synchronous completion", () => {
    let tick = 0;
    let waitId = 0;
    const state = new WaitState({
        now: () => new Date(Date.parse("2026-08-18T00:00:00.000Z") + tick++ * 1_000).toISOString(),
        waitId: () => `wait-${++waitId}`,
    });
    const detached = state.detach(
        state.create(state.emptyDocument(), {
            createdByCtxId: "ctx-1",
            kind: "tmux",
            ownerCallId: "call-wait",
            targetId: "tmux-detached",
        }).document,
        "wait-1",
    );
    const consumed = state.resolve(
        detached.document,
        detached.record.waitId,
        { task: { id: "tmux-detached", status: "0" } },
        { consumeIfDetached: true },
    );
    assert.equal(consumed.record.status, "consumed");
    assert.equal(consumed.record.resolvedAt, consumed.record.consumedAt);
    assert.deepEqual(consumed.record.result, { task: { id: "tmux-detached", status: "0" } });

    const waiting = state.create(consumed.document, {
        createdByCtxId: "ctx-1",
        kind: "tmux",
        ownerCallId: "call-sync",
        targetId: "tmux-sync",
    });
    const resolved = state.resolve(
        waiting.document,
        waiting.record.waitId,
        { task: { id: "tmux-sync", status: "0" } },
        { consumeIfDetached: true },
    );
    assert.equal(resolved.record.status, "resolved");
    assert.equal(resolved.record.consumedAt, undefined);
});

test("WaitState bounds terminal history and drops transient terminal payloads without truncating recoverable waits", () => {
    const state = new WaitState();
    const terminal = Array.from({ length: 300 }, (_, index) => ({
        consumedAt: new Date(index + 1_000).toISOString(),
        createdAt: new Date(index).toISOString(),
        createdByCtxId: "ctx-terminal",
        kind: "tmux" as const,
        payload: { line: 80 },
        resolvedAt: new Date(index + 500).toISOString(),
        result: { output: `terminal-${index}` },
        status: "consumed" as const,
        targetId: `task-terminal-${index}`,
        updatedAt: new Date(index + 1_000).toISOString(),
        waitId: `wait-terminal-${index}`,
    }));
    const recoverable = {
        createdAt: new Date(10_000).toISOString(),
        createdByCtxId: "ctx-recoverable",
        detachedAt: new Date(10_001).toISOString(),
        kind: "tmux" as const,
        payload: { line: 120 },
        resolvedAt: new Date(10_002).toISOString(),
        result: { output: "recover me" },
        status: "resolved" as const,
        targetId: "task-recoverable",
        updatedAt: new Date(10_002).toISOString(),
        waitId: "wait-recoverable",
    };

    const compacted = state.compact({ version: 1, waits: [...terminal, recoverable] });
    const retainedTerminal = compacted.waits.filter((record) => record.status === "consumed");
    const retainedRecoverable = compacted.waits.find((record) => record.waitId === recoverable.waitId);

    assert.equal(retainedTerminal.length, 256);
    assert.equal(retainedTerminal.every((record) => record.payload === undefined && record.result === undefined), true);
    assert.deepEqual(retainedRecoverable?.payload, recoverable.payload);
    assert.deepEqual(retainedRecoverable?.result, recoverable.result);
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

test("WaitState rejects a second recoverable tmux wait for the same Context and task", () => {
    let nextWait = 0;
    const state = new WaitState({ waitId: () => `wait-${++nextWait}` });
    const first = state.create(state.emptyDocument(), {
        createdByCtxId: "ctx-1",
        kind: "tmux",
        targetId: "tmux-task-1",
        targetInstance: "worker-a",
    });

    assert.throws(
        () => state.create(first.document, {
            createdByCtxId: "ctx-1",
            kind: "tmux",
            targetId: "tmux-task-1",
            targetInstance: "worker-a",
        }),
        /already has recoverable wait wait-1/u,
    );

    const otherContext = state.create(first.document, {
        createdByCtxId: "ctx-2",
        kind: "tmux",
        targetId: "tmux-task-1",
        targetInstance: "worker-a",
    });
    assert.equal(otherContext.record.waitId, "wait-2");

    const otherInstance = state.create(otherContext.document, {
        createdByCtxId: "ctx-1",
        kind: "tmux",
        targetId: "tmux-task-1",
        targetInstance: "worker-b",
    });
    assert.equal(otherInstance.record.waitId, "wait-3");

    const cancelled = state.cancel(otherInstance.document, first.record.waitId);
    const replacement = state.create(cancelled.document, {
        createdByCtxId: "ctx-1",
        kind: "tmux",
        targetId: "tmux-task-1",
        targetInstance: "worker-a",
    });
    assert.equal(replacement.record.waitId, "wait-4");
});

test("WaitState reconciles duplicate recoverable tmux waits and preserves uncertain delivery", () => {
    const state = new WaitState({ now: () => "2026-08-18T00:10:00.000Z" });
    const normalized = state.normalizeDocument({
        version: 1,
        waits: [
            {
                createdAt: "2026-08-18T00:00:00.000Z",
                createdByCtxId: "ctx-1",
                detachedAt: "2026-08-18T00:00:01.000Z",
                kind: "tmux",
                status: "detached",
                targetId: "tmux-task-1",
                targetInstance: "worker-a",
                updatedAt: "2026-08-18T00:00:01.000Z",
                waitId: "wait-old",
            },
            {
                createdAt: "2026-08-18T00:01:00.000Z",
                createdByCtxId: "ctx-1",
                detachedAt: "2026-08-18T00:01:01.000Z",
                kind: "tmux",
                recoveryMessageAttemptedAt: "2026-08-18T00:01:02.000Z",
                recoveryMessageId: "recovery-uncertain",
                resolvedAt: "2026-08-18T00:01:01.000Z",
                result: { task: { id: "tmux-task-1", status: "0" } },
                status: "resolved",
                targetId: "tmux-task-1",
                targetInstance: "worker-a",
                updatedAt: "2026-08-18T00:01:02.000Z",
                waitId: "wait-uncertain",
            },
            {
                createdAt: "2026-08-18T00:02:00.000Z",
                createdByCtxId: "ctx-1",
                detachedAt: "2026-08-18T00:02:01.000Z",
                kind: "tmux",
                status: "detached",
                targetId: "tmux-task-1",
                targetInstance: "worker-a",
                updatedAt: "2026-08-18T00:02:01.000Z",
                waitId: "wait-new",
            },
            {
                createdAt: "2026-08-18T00:03:00.000Z",
                createdByCtxId: "ctx-2",
                detachedAt: "2026-08-18T00:03:01.000Z",
                kind: "tmux",
                status: "detached",
                targetId: "tmux-task-1",
                targetInstance: "worker-a",
                updatedAt: "2026-08-18T00:03:01.000Z",
                waitId: "wait-other-context",
            },
        ],
    });

    const byId = new Map(normalized.waits.map((wait) => [wait.waitId, wait]));
    assert.equal(byId.get("wait-uncertain")?.status, "resolved");
    assert.equal(byId.get("wait-old")?.status, "cancelled");
    assert.equal(byId.get("wait-new")?.status, "cancelled");
    assert.equal(byId.get("wait-other-context")?.status, "detached");
});

test("WaitService serializes concurrent creation of the same tmux wait target", async () => {
    const root = await createTestTempDirectory("wait-service-tmux-dedupe-");
    const service = new WaitService({
        appendEvent: async () => undefined,
        filePath: join(root, "waits.json"),
        instanceName: "aromatic-pc",
    });
    const input = {
        createdByCtxId: "ctx-1",
        kind: "tmux" as const,
        targetId: "tmux-task-1",
        targetInstance: "worker-a",
    };

    const results = await Promise.allSettled([
        service.create(input),
        service.create(input),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected?.status, "rejected");
    if (rejected?.status === "rejected") {
        assert.match(String(rejected.reason), /already has recoverable wait/u);
    }
    const waits = await service.list();
    assert.equal(waits.length, 1);
    assert.equal(waits[0]?.status, "waiting");
});

test("WaitService emits consumed directly when a detached completion is already owned by active Agent work", async () => {
    const root = await createTestTempDirectory("wait-service-consumed-completion-");
    const events: string[] = [];
    const service = new WaitService({
        appendEvent: async (type) => { events.push(type); },
        filePath: join(root, "waits.json"),
        instanceName: "aromatic-pc",
    });
    const created = await service.create({
        createdByCtxId: "ctx-1",
        kind: "tmux",
        ownerCallId: "call-wait",
        targetId: "tmux-task-1",
    });
    await service.detach(created.waitId);
    const completed = await service.resolve(
        created.waitId,
        { task: { id: "tmux-task-1", status: "0" } },
        { consumeIfDetached: true },
    );

    assert.equal(completed.status, "consumed");
    assert.equal(completed.resolvedAt, completed.consumedAt);
    assert.deepEqual(events, ["wait.created", "wait.detached", "wait.consumed"]);
});

test("WaitState atomically completes an accepted recovery delivery", () => {
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
    const completed = state.completeRecovery(attempted.document, created.record.waitId, "claim-1");
    assert.equal(completed.record.status, "consumed");
    assert.equal(typeof completed.record.recoveryMessageSentAt, "string");
    assert.equal(completed.record.consumedAt, completed.record.recoveryMessageSentAt);
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
        /not marked attempted/u,
    );
    const reattempted = state.markRecoveryAttempted(reclaimed.document, created.record.waitId, "claim-2");
    const completedAfterRetry = state.completeRecovery(reattempted.document, created.record.waitId, "claim-2");
    assert.equal(completedAfterRetry.record.status, "consumed");
    assert.equal(completedAfterRetry.record.recoveryClaimId, undefined);
});

test("WaitState migrates legacy delivered recovery only when loading persisted state", () => {
    const state = new WaitState();
    const legacy = state.normalizeDocument({
        version: 1,
        waits: [{
            createdAt: "2026-08-18T00:00:00.000Z",
            createdByCtxId: "ctx-1",
            detachedAt: "2026-08-18T00:00:01.000Z",
            kind: "tmux",
            recoveryMessageAttemptedAt: "2026-08-18T00:00:02.000Z",
            recoveryMessageId: "legacy-delivery",
            recoveryMessageSentAt: "2026-08-18T00:00:03.000Z",
            resolvedAt: "2026-08-18T00:00:01.500Z",
            result: { task: { id: "tmux-task-delivered", status: "0" } },
            status: "resolved",
            targetId: "tmux-task-delivered",
            updatedAt: "2026-08-18T00:00:03.000Z",
            waitId: "wait-delivered",
        }],
    });

    assert.equal(legacy.waits[0]?.status, "resolved");
    const migrated = state.migrateLoadedDocument(legacy);
    assert.equal(migrated.waits[0]?.status, "consumed");
    assert.equal(migrated.waits[0]?.consumedAt, "2026-08-18T00:00:03.000Z");
    assert.equal(migrated.waits[0]?.recoveryClaimId, undefined);
});

test("WaitStore applies delivered-recovery migration on reload but not on ordinary writes", async () => {
    const root = await createTestTempDirectory("wait-store-delivery-migration-");
    const filePath = join(root, "waits.json");
    const state = new WaitState();
    const store = new WaitStore({ filePath, instanceName: "aromatic-pc", state });
    const legacy = state.normalizeDocument({
        version: 1,
        waits: [{
            createdAt: "2026-08-18T00:00:00.000Z",
            createdByCtxId: "ctx-1",
            detachedAt: "2026-08-18T00:00:01.000Z",
            kind: "tmux",
            recoveryMessageAttemptedAt: "2026-08-18T00:00:02.000Z",
            recoveryMessageId: "legacy-delivery",
            recoveryMessageSentAt: "2026-08-18T00:00:03.000Z",
            resolvedAt: "2026-08-18T00:00:01.500Z",
            status: "resolved",
            targetId: "tmux-task-delivered",
            updatedAt: "2026-08-18T00:00:03.000Z",
            waitId: "wait-delivered",
        }],
    });

    await store.write(legacy);
    assert.equal(store.read().waits[0]?.status, "resolved");

    const reloaded = new WaitStore({ filePath, instanceName: "aromatic-pc", state });
    assert.equal(reloaded.read().waits[0]?.status, "consumed");
    assert.equal(reloaded.read().waits[0]?.consumedAt, "2026-08-18T00:00:03.000Z");
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

    const claimedAgain = state.claimRecovery(resolved.document, created.record.waitId, "claim-complete");
    const attemptedAgain = state.markRecoveryAttempted(claimedAgain.document, created.record.waitId, "claim-complete");
    const completed = state.completeRecovery(attemptedAgain.document, created.record.waitId, "claim-complete");
    assert.equal(completed.record.status, "consumed");
    assert.equal(completed.record.recoveryMessageSentAt, completed.record.consumedAt);
});

test("WaitState can safely retry a delivery that the Host definitively rejected", () => {
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
    const rejected = state.rejectRecovery(attempted.document, created.record.waitId, "claim-1");

    assert.equal(rejected.record.status, "resolved");
    assert.equal(rejected.record.recoveryClaimId, undefined);
    assert.equal(rejected.record.recoveryMessageAttemptedAt, undefined);
    const reclaimed = state.claimRecovery(rejected.document, created.record.waitId, "claim-2");
    assert.equal(reclaimed.record.recoveryClaimId, "claim-2");
});

test("WaitState disables automatic recovery without stopping the underlying wait target", () => {
    const state = new WaitState({ waitId: () => "wait-fixed" });
    const created = state.create(state.emptyDocument(), {
        createdByCtxId: "ctx-1",
        kind: "tmux",
        targetId: "tmux-task-1",
    });
    const detached = state.detach(created.document, created.record.waitId);
    const disabled = state.disableRecovery(detached.document, created.record.waitId);

    assert.equal(disabled.record.status, "detached");
    assert.equal(disabled.record.automaticRecovery, false);
    assert.equal(typeof disabled.record.recoveryDisabledAt, "string");
    const resolved = state.resolve(disabled.document, created.record.waitId, { task: { status: "0" } });
    assert.throws(
        () => state.claimRecovery(resolved.document, created.record.waitId, "claim-1"),
        /not available for automatic recovery/u,
    );
});

test("WaitState disabling recovery retires an uncertain delivery fence idempotently", () => {
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
    const disabled = state.disableRecovery(attempted.document, created.record.waitId);
    const repeated = state.disableRecovery(disabled.document, created.record.waitId);

    assert.equal(repeated.record.status, "resolved");
    assert.equal(repeated.record.automaticRecovery, false);
    assert.equal(repeated.record.recoveryClaimId, undefined);
    assert.equal(repeated.record.recoveryMessageAttemptedAt, undefined);
    assert.equal(repeated.record.recoveryMessageId, undefined);
    assert.equal(typeof repeated.record.recoveryDisabledAt, "string");
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
