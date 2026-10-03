import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, MessageStream } from "@portable-devshell/shared";
import { ContextChangeHub } from "../../../../src/context/Registry/Change.js";
import { ContextRegistry } from "../../../../src/context/Registry/index.js";
import { createContextRouteModule } from "../../../../src/context/Route.js";

test("Context changes replay inclusively and report a bounded-history gap", () => {
    const changes = new ContextChangeHub({ historyLimit: 2 });
    assert.equal(changes.publish([]), 0);
    assert.equal(changes.publish(["ctx-b", "ctx-a", "ctx-b"]), 1);
    changes.publish(["ctx-a"]);
    changes.publish(["ctx-b"]);
    assert.deepEqual(changes.readSince(1), {
        changes: [], kind: "gap", latestRevision: 3, oldestAvailableRevision: 2,
    });
    assert.deepEqual(changes.readSince(2).changes, [
        { ctxIds: ["ctx-a"], revision: 2 },
        { ctxIds: ["ctx-b"], revision: 3 },
    ]);
    assert.equal(changes.readSince(4).changes.length, 0);
});

test("Context changes report a gap for future cursors but allow latest plus one", () => {
    const changes = new ContextChangeHub({ historyLimit: 2 });
    changes.publish(["ctx-a"]);
    changes.publish(["ctx-b"]);
    assert.deepEqual(changes.readSince(3), {
        changes: [], kind: "events", latestRevision: 2, oldestAvailableRevision: 1,
    });
    assert.deepEqual(changes.readSince(4), {
        changes: [], kind: "gap", latestRevision: 2, oldestAvailableRevision: 1,
    });
});

test("Context revisions include public touches and environments but exclude claims, execution, and cleanup debt", async () => {
    let now = Date.parse("2026-10-03T00:00:00Z");
    const registry = new ContextRegistry({ idFactory: () => "ctx-public", now: () => now });
    const created = await registry.create({ principal: "user", environments: [{ instance: "local", workspace: "/old" }] });
    assert.equal(registry.changes.revision, 1);
    await registry.reentry.claimAutomaticReentry(created.ctxId, "local", "claim-private");
    await registry.reentry.observeExecutionActivity(created.ctxId, "local");
    await registry.reentry.suppressAutomaticReentry(created.ctxId, "local", "private reason");
    await registry.recordEnvironmentCleanup(created.ctxId, { instance: "remote", kind: "instance_reference" });
    assert.equal(registry.changes.revision, 1);
    assert.deepEqual(Object.keys((await registry.snapshot()).contexts[0]).sort(), [
        "createdAt", "ctxId", "environments", "expiresAt", "lastAccessedAt", "principal", "status",
    ]);
    now += 1_000;
    const touched = await registry.validateAndTouch(created.ctxId, { principal: "user" });
    assert.equal(touched.lastAccessedAt, new Date(now).toISOString());
    assert.equal(registry.changes.revision, 2);
    await registry.updateWorkerState(created.ctxId, "local", { workspace: "/new" });
    assert.equal(registry.changes.revision, 3);
    const snapshot = await registry.snapshot();
    assert.equal(snapshot.revision, 3);
    assert.equal(snapshot.contexts[0].environments[0].workspace, "/new");
    await registry.disable(created.ctxId);
    assert.equal(registry.changes.revision, 4);
    assert.deepEqual(registry.changes.readSince(1).changes, [1, 2, 3, 4].map(revision => ({ ctxIds: [created.ctxId], revision })));
});

test("snapshot observes expiry and terminal compaction as public record changes", async () => {
    let now = 0;
    const registry = new ContextRegistry({ idFactory: () => "ctx-expiry", now: () => now, ttlMs: 1_000, maxTerminalContexts: 0 });
    const created = await registry.create({ principal: "user" });
    now = 1_000;
    const expired = await registry.snapshot();
    assert.equal(expired.revision, 2);
    assert.equal(expired.contexts[0].status, "expired");
    await registry.disable(created.ctxId);
    await registry.settleCleanup(created.ctxId);
    assert.deepEqual(await registry.snapshot(), { contexts: [], revision: 4 });
});

test("snapshot uses one clock value for its records and revision", async () => {
    let currentNow = 0;
    let snapshotTimes: number[] = [];
    const registry = new ContextRegistry({
        idFactory: () => "ctx-snapshot-boundary",
        now: () => snapshotTimes.shift() ?? currentNow,
        ttlMs: 1_000,
    });
    await registry.create({ principal: "user" });
    snapshotTimes = [999, 1_000];

    const snapshot = await registry.snapshot();

    assert.equal(snapshot.contexts[0]!.status, "active");
    assert.equal(snapshot.revision, 1);
    assert.equal(registry.changes.revision, 2);
});

test("failed persistence does not publish a Context record that was rolled back", async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "context-change-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const filePath = join(directory, "contexts.json");
    const registry = new ContextRegistry({ filePath, idFactory: () => "ctx-rollback" });
    await registry.initialize();
    const created = await registry.create({ principal: "user" });
    await rm(filePath);
    await mkdir(filePath);
    await assert.rejects(registry.disable(created.ctxId));
    assert.equal(registry.changes.revision, 1);
    assert.equal((await registry.snapshot()).contexts[0].status, "active");
});

test("Context route seeds replay, orders live events, reports gaps, and unregisters on close", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-route" });
    await registry.create({ principal: "user" });
    const route = createContextRouteModule({
        registry,
        disable: (ctxId) => registry.disable(ctxId),
        renew: (ctxId) => registry.renew(ctxId),
    });
    const snapshot = route.operations.find(operation => operation.name === "snapshot")!;
    assert.ok(snapshot);
    assert.deepEqual(await snapshot.handle({ id: "snapshot", name: "snapshot" }, {} as never), await registry.snapshot());
    const subscribe = route.streams!.find(operation => operation.name === "subscribe")!;
    assert.ok(subscribe);
    const frames: unknown[] = [];
    let close: () => void = () => {};
    const stream = {
        async send(frame: unknown) { frames.push(frame); },
        onClose(listener: () => void) { close = listener; },
        onCancel() {},
    } as unknown as MessageStream;
    await subscribe.handle(stream, { id: "subscribe", name: "subscribe", payload: { fromRevision: 1 } }, {} as never);
    await registry.disable("ctx-route");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(frames, [1, 2].map(revision => ({ name: "event", payload: { ctxIds: ["ctx-route"], revision }, seq: revision })));
    close();
    registry.changes.publish(["ctx-after-close"]);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(frames.length, 2);
    for (let index = 0; index < 128; index += 1) registry.changes.publish(["ctx-route"]);
    const gapFrames: unknown[] = [];
    await subscribe.handle({ ...stream, async send(frame: unknown) { gapFrames.push(frame); } } as MessageStream, {
        id: "gap", name: "subscribe", payload: { fromRevision: 1 },
    }, {} as never);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(gapFrames, [{ name: "gap", payload: { latestSeq: 131, oldestAvailableSeq: 4, requestedFromSeq: 1 } }]);
    close();
    await assert.rejects(async () => subscribe.handle(stream, {
        id: "invalid", name: "subscribe", payload: { fromRevision: -1 } as JsonValue,
    }, {} as never));
});
