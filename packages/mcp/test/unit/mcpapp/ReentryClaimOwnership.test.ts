import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createToolCallRuntime, type JsonValue } from "@portable-devshell/shared";
import { installMcpAppReentry } from "../../../../core/src/instance/mcpapp/Reentry.ts";
import { GoalService } from "../../../../core/src/task/goal/index.ts";
import { McpAppActionStore } from "../../../src/mcpapp/ActionStore.ts";
import { deliverMcpAppReentry } from "../../../src/mcpapp/Reentry.ts";
import { betaReentry } from "../../support/BetaReentry.ts";

type Fixture = Awaited<ReturnType<typeof betaReentry>>;
type Dispatch = (input: JsonValue, execute: () => Promise<JsonValue>) => Promise<JsonValue>;

function delivery(fixture: Fixture, actions = fixture.actions, dispatch: Dispatch = async (_input, execute) => execute()) {
    return (input: Record<string, JsonValue>) => deliverMcpAppReentry({
        actions, context: { resolve: fixture.contexts.resolve }, instance: "local",
        dispatch: { async callTool(_name, payload) {
            return await dispatch(payload, () => fixture.native.api.call("local", "mcpapp_reentry", payload, {
                ctxId: fixture.context.ctxId, workspace: "/repo", source: "mcp",
            }));
        } },
        view: { async snapshot() { return {
            presentation: { work: [] }, modelContext: { content: [] },
        }; } } as never,
    }, { ...fixture.base, ...input }, { principal: "owner" });
}

async function blockPersistence(filePath: string) {
    await rename(filePath, `${filePath}.saved`);
    await mkdir(filePath);
}

async function unblockPersistence(filePath: string) {
    await rm(filePath, { recursive: true });
    await rename(`${filePath}.saved`, filePath);
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

test("Reentry stale owner cannot mutate any stage after release, replacement claim and store restart", async () => {
    const fixture = await betaReentry();
    try {
        await fixture.call({ action: "claim", claimId: "crashed-host" });
        await fixture.call({ action: "release", claimId: "crashed-host" });
        await fixture.call({ action: "claim" });
        const restarted = new McpAppActionStore({ filePath: fixture.filePath });
        await restarted.initialize();
        const call = delivery(fixture, restarted);
        const before = fixture.executions();
        const receipt = await restarted.get(fixture.directiveId);
        assert.equal(receipt?.claimId, fixture.base.claimId);
        assert.deepEqual(await call({ action: "validate", claimId: "crashed-host" }), { valid: false });
        assert.deepEqual(await call({ action: "attempt", claimId: "crashed-host" }), { attempted: false });
        assert.deepEqual(await call({ action: "release", claimId: "crashed-host" }), { released: false });
        assert.deepEqual(await call({ action: "report", outcome: "accepted", claimId: "crashed-host" }), { reported: false });
        assert.deepEqual(await restarted.get(fixture.directiveId), receipt);
        assert.equal(fixture.executions(), before);
        assert.equal((await call({ action: "attempt" }) as { attempted: boolean }).attempted, true);
        for (const outcome of ["accepted", "rejected", "uncertain"]) {
            assert.deepEqual(await call({ action: "report", outcome, claimId: "crashed-host" }), { reported: false });
            assert.equal((await restarted.get(fixture.directiveId))?.status, "attempted");
        }
        await call({ action: "report", outcome: "accepted" });
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationCount, 1);
    } finally { await fixture.close(); }
});

test("Reentry store compares owner and lifecycle atomically without writing on a failed precondition", async () => {
    const fixture = await betaReentry();
    try {
        const store = fixture.actions;
        assert.ok(await store.beginDelivery(fixture.directiveId, "old-owner"));
        assert.equal(await store.restoreDelivery(fixture.directiveId, "old-owner"), true);
        assert.ok(await store.beginDelivery(fixture.directiveId, "new-owner"));
        const persisted = await readFile(fixture.filePath, "utf8");
        assert.equal(await store.restoreDelivery(fixture.directiveId, "old-owner"), false);
        assert.equal(await store.markAttempted(fixture.directiveId, "old-owner"), undefined);
        assert.equal(await store.beginReport(fixture.directiveId, "old-owner", "accepted"), undefined);
        assert.equal(await store.beginReport(fixture.directiveId, "new-owner", "accepted"), undefined);
        assert.equal(await store.settle(fixture.directiveId, "old-owner", "accepted"), undefined);
        assert.equal(await store.settle(fixture.directiveId, "new-owner", "accepted"), undefined);
        assert.equal(await readFile(fixture.filePath, "utf8"), persisted);
        assert.equal(await store.markAttempted(fixture.directiveId, "new-owner"), undefined);
        assert.equal(await store.beginAttempt(fixture.directiveId, "new-owner"), undefined);
        assert.equal(await store.confirmDelivery(fixture.directiveId, "old-owner", "new-owner"), undefined);
        assert.ok(await store.confirmDelivery(fixture.directiveId, "new-owner", "new-owner"));
        assert.equal(await store.beginAttempt(fixture.directiveId, "old-owner"), undefined);
        assert.ok(await store.beginAttempt(fixture.directiveId, "new-owner"));
        assert.ok(await store.markAttempted(fixture.directiveId, "new-owner"));
        assert.equal(await store.restoreDelivery(fixture.directiveId, "new-owner"), false);
        assert.ok(await store.beginReport(fixture.directiveId, "new-owner", "accepted"));
        assert.equal(await store.beginReport(fixture.directiveId, "new-owner", "rejected"), undefined);
        assert.equal(await store.settle(fixture.directiveId, "old-owner", "accepted"), undefined);
        assert.equal(await store.settle(fixture.directiveId, "new-owner", "rejected"), undefined);
        const settled = await store.settle(fixture.directiveId, "new-owner", "accepted");
        assert.equal(settled?.status, "settled");
        assert.deepEqual(await store.settle(fixture.directiveId, "new-owner", "accepted"), settled);
    } finally { await fixture.close(); }
});

test("Reentry concurrent attempts deliver one permission to resume and execute Instance once", async () => {
    const fixture = await betaReentry();
    try {
        await fixture.call({ action: "claim" });
        const before = fixture.executions();
        const replies = await Promise.all(Array.from({ length: 12 }, () => fixture.call({ action: "attempt" })));
        assert.equal(replies.filter((reply) => (reply as { attempted: boolean }).attempted).length, 1);
        assert.equal(replies.filter((reply) => (reply as { duplicate: boolean }).duplicate).length, 11);
        assert.equal(fixture.executions(), before + 1);
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "attempted");
    } finally { await fixture.close(); }
});

test("Reentry release waits for an in-flight attempt and cannot reopen an attempted receipt", async () => {
    const fixture = await betaReentry();
    const entered = deferred();
    const resume = deferred();
    try {
        await fixture.call({ action: "claim" });
        const call = delivery(fixture, fixture.actions, async (_input, execute) => {
            entered.resolve();
            await resume.promise;
            return execute();
        });
        const attempting = call({ action: "attempt" });
        await entered.promise;
        const releasing = fixture.call({ action: "release" });
        resume.resolve();
        assert.equal((await attempting as { attempted: boolean }).attempted, true);
        assert.deepEqual(await releasing, { released: false });
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "attempted");
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationPending, true);
    } finally { resume.resolve(); await fixture.close(); }
});

test("Reentry simultaneous reports commit one Goal continuation and fence conflicting outcomes", async () => {
    const fixture = await betaReentry();
    try {
        await fixture.call({ action: "claim" });
        await fixture.call({ action: "attempt" });
        const before = fixture.executions();
        const reports = await Promise.all(Array.from({ length: 10 }, () => fixture.call({ action: "report", outcome: "accepted" })));
        assert.equal(reports.filter((reply) => (reply as { reported: boolean }).reported).length, 1);
        assert.equal(fixture.executions(), before + 1);
        assert.deepEqual(await fixture.call({ action: "report", outcome: "rejected" }), { reported: false });
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationCount, 1);
        assert.equal((await fixture.actions.get(fixture.directiveId))?.outcome, "accepted");
    } finally { await fixture.close(); }
});

test("Reentry owner uncertain report survives restart without replay and permits a definitive acknowledgement", async () => {
    const fixture = await betaReentry();
    try {
        await fixture.call({ action: "claim" });
        await fixture.call({ action: "attempt" });
        assert.deepEqual(await fixture.call({ action: "report", outcome: "uncertain" }), { uncertain: true });
        const restarted = new McpAppActionStore({ filePath: fixture.filePath });
        await restarted.initialize();
        const call = delivery(fixture, restarted);
        assert.equal((await restarted.get(fixture.directiveId))?.claimId, fixture.base.claimId);
        assert.equal((await restarted.get(fixture.directiveId))?.status, "settled");
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationPending, true);
        assert.deepEqual(await call({ action: "claim", claimId: "another-host" }), { claimed: false });
        assert.deepEqual(await call({ action: "attempt" }), { attempted: false });
        assert.deepEqual(await call({ action: "report", outcome: "accepted", claimId: "another-host" }), { reported: false });
        assert.equal((await call({ action: "report", outcome: "accepted" }) as { reported: boolean }).reported, true);
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationPending, false);
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationCount, 1);
    } finally { await fixture.close(); }
});

test("Reentry failed report persistence occurs before Instance mutation and can be retried", async () => {
    const fixture = await betaReentry();
    try {
        await fixture.call({ action: "claim" });
        await fixture.call({ action: "attempt" });
        const before = fixture.executions();
        await blockPersistence(fixture.filePath);
        await assert.rejects(fixture.call({ action: "report", outcome: "accepted" }));
        assert.equal(fixture.executions(), before);
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "attempted");
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationCount, 0);
        await unblockPersistence(fixture.filePath);
        await fixture.call({ action: "report", outcome: "accepted" });
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationCount, 1);
    } finally { await fixture.close(); }
});

test("Reentry lost report reply after Goal commit recovers after both stores restart without double counting", async () => {
    const fixture = await betaReentry();
    try {
        await fixture.call({ action: "claim" });
        await fixture.call({ action: "attempt" });
        const interrupted = delivery(fixture, fixture.actions, async (_input, execute) => {
            await execute();
            throw new Error("report response lost after commit");
        });
        await assert.rejects(interrupted({ action: "report", outcome: "accepted" }), /response lost/u);
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "reporting");
        const goal = new GoalService({ appendEvent: async () => undefined,
            filePath: join(dirname(fixture.filePath), "goals.json"), instanceName: "local" });
        const restarted = new McpAppActionStore({ filePath: fixture.filePath });
        await restarted.initialize();
        const native = createToolCallRuntime({ resolveTarget: () => ({ async dispatch(request) {
            assert.ok(request.execute);
            return await request.execute(request.callId, request.value.payload, request.value) as JsonValue;
        } }) });
        const stop = installMcpAppReentry(native.hooks, { goal, todo: fixture.todo } as never);
        try {
            const call = delivery(fixture, restarted, (input) => native.api.call("local", "mcpapp_reentry", input, {
                ctxId: fixture.context.ctxId, workspace: "/repo", source: "mcp",
            }));
            assert.equal((await goal.read(fixture.context.ctxId))?.continuationCount, 1);
            assert.deepEqual(await call({ action: "report", outcome: "rejected" }), { reported: false });
            assert.deepEqual(await call({ action: "report", outcome: "accepted", claimId: "wrong-host" }), { reported: false });
            assert.equal((await call({ action: "report", outcome: "accepted" }) as { reported: boolean }).reported, true);
            assert.equal((await restarted.get(fixture.directiveId))?.status, "settled");
            assert.equal((await goal.read(fixture.context.ctxId))?.continuationCount, 1);
        } finally { stop(); native.close(); }
    } finally { await fixture.close(); }
});

test("Reentry settlement write failure leaves a recoverable reporting receipt", async () => {
    const fixture = await betaReentry();
    try {
        await fixture.call({ action: "claim" });
        await fixture.call({ action: "attempt" });
        const failing = delivery(fixture, fixture.actions, async (_input, execute) => {
            const result = await execute();
            await blockPersistence(fixture.filePath);
            return result;
        });
        await assert.rejects(failing({ action: "report", outcome: "accepted" }));
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "reporting");
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationCount, 1);
        await unblockPersistence(fixture.filePath);
        const restarted = new McpAppActionStore({ filePath: fixture.filePath });
        await restarted.initialize();
        await delivery(fixture, restarted)({ action: "report", outcome: "accepted" });
        assert.equal((await restarted.get(fixture.directiveId))?.status, "settled");
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationCount, 1);
    } finally { await fixture.close(); }
});

test("Reentry failed attempt write recovers the Instance attempt without granting a second resume", async () => {
    const fixture = await betaReentry();
    try {
        await fixture.call({ action: "claim" });
        const failing = delivery(fixture, fixture.actions, async (_input, execute) => {
            const result = await execute();
            await blockPersistence(fixture.filePath);
            return result;
        });
        await assert.rejects(failing({ action: "attempt" }));
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "attempting");
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationUncertain, true);
        await unblockPersistence(fixture.filePath);
        const restarted = new McpAppActionStore({ filePath: fixture.filePath });
        await restarted.initialize();
        const call = delivery(fixture, restarted);
        assert.deepEqual(await call({ action: "attempt" }), { attempted: false, duplicate: true });
        assert.equal((await restarted.get(fixture.directiveId))?.status, "attempted");
        await call({ action: "report", outcome: "uncertain" });
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationCount, 0);
        assert.deepEqual(await call({ action: "claim" }), { claimed: false });
    } finally { await fixture.close(); }
});

test("Reentry failed attempt reservation never dispatches Instance and leaves the unattempted receipt usable", async () => {
    const fixture = await betaReentry();
    try {
        await fixture.call({ action: "claim" });
        const before = fixture.executions();
        await blockPersistence(fixture.filePath);
        await assert.rejects(fixture.call({ action: "attempt" }));
        assert.equal(fixture.executions(), before);
        assert.equal((await fixture.actions.get(fixture.directiveId))?.attemptStarted, undefined);
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationUncertain, false);
        await unblockPersistence(fixture.filePath);
        assert.equal((await fixture.call({ action: "attempt" }) as { attempted: boolean }).attempted, true);
    } finally { await fixture.close(); }
});

test("Reentry failed claim confirmation retains the claiming fence until confirmed release and survives restart", async () => {
    const fixture = await betaReentry();
    try {
        const failing = delivery(fixture, fixture.actions, async (input, execute) => {
            const result = await execute();
            if ((input as { action: string }).action === "claim") await blockPersistence(fixture.filePath);
            return result;
        });
        await assert.rejects(failing({ action: "claim" }));
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "claiming");
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationPending, false);
        await unblockPersistence(fixture.filePath);
        const restarted = new McpAppActionStore({ filePath: fixture.filePath });
        await restarted.initialize();
        const call = delivery(fixture, restarted);
        const before = fixture.executions();
        assert.deepEqual(await call({ action: "attempt" }), { attempted: false });
        assert.equal(fixture.executions(), before);
        assert.equal((await call({ action: "claim", claimId: "replacement-owner" }) as { claimed: boolean }).claimed, true);
        assert.deepEqual(await call({ action: "attempt" }), { attempted: false });
        assert.equal((await call({ action: "attempt", claimId: "replacement-owner" }) as { attempted: boolean }).attempted, true);
    } finally { await fixture.close(); }
});

test("Reentry failed claim reply after Instance commit confirms release before retry", async () => {
    const fixture = await betaReentry();
    try {
        const failing = delivery(fixture, fixture.actions, async (input, execute) => {
            const result = await execute();
            if ((input as { action: string }).action === "claim") throw new Error("claim reply lost");
            return result;
        });
        await assert.rejects(failing({ action: "claim" }), /claim reply lost/u);
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "applied");
        assert.equal((await fixture.actions.get(fixture.directiveId))?.claimId, undefined);
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationPending, false);
        assert.equal((await fixture.call({ action: "claim", claimId: "recovered-host" }) as { claimed: boolean }).claimed, true);
    } finally { await fixture.close(); }
});

test("Reentry an unconfirmed Instance release cannot reopen a claimed receipt", async () => {
    const fixture = await betaReentry();
    try {
        await fixture.call({ action: "claim" });
        const denied = delivery(fixture, fixture.actions, async () => ({ released: false }));
        assert.deepEqual(await denied({ action: "release" }), { released: false });
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "attempting");
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationPending, true);
        assert.equal((await fixture.call({ action: "attempt" }) as { attempted: boolean }).attempted, true);
    } finally { await fixture.close(); }
});

test("Reentry failed claim reservation rolls back without dispatching Instance", async () => {
    const fixture = await betaReentry();
    try {
        await blockPersistence(fixture.filePath);
        await assert.rejects(fixture.call({ action: "claim" }));
        assert.equal(fixture.executions(), 0);
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "applied");
        assert.equal((await fixture.actions.get(fixture.directiveId))?.claimId, undefined);
        await unblockPersistence(fixture.filePath);
        assert.equal((await fixture.call({ action: "claim" }) as { claimed: boolean }).claimed, true);
    } finally { await fixture.close(); }
});

test("Reentry failed claim cleanup keeps ownership until Instance release is confirmed", async () => {
    const fixture = await betaReentry();
    try {
        const failing = delivery(fixture, fixture.actions, async (input, execute) => {
            if ((input as { action: string }).action === "release") return { released: false };
            await execute();
            throw new Error("claim reply lost");
        });
        await assert.rejects(failing({ action: "claim" }), /claim reply lost/u);
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "claiming");
        assert.equal((await fixture.actions.get(fixture.directiveId))?.claimId, fixture.base.claimId);
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationPending, true);
        assert.deepEqual(await fixture.call({ action: "claim", claimId: "another-host" }), { claimed: false });
        assert.equal((await fixture.call({ action: "release" }) as { released: boolean }).released, true);
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "applied");
        assert.equal((await fixture.call({ action: "claim", claimId: "another-host" }) as { claimed: boolean }).claimed, true);
    } finally { await fixture.close(); }
});

test("Reentry release write failure retries safely after the Instance already released", async () => {
    const fixture = await betaReentry();
    try {
        await fixture.call({ action: "claim" });
        const failing = delivery(fixture, fixture.actions, async (_input, execute) => {
            const result = await execute();
            await blockPersistence(fixture.filePath);
            return result;
        });
        await assert.rejects(failing({ action: "release" }));
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "attempting");
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationPending, false);
        await unblockPersistence(fixture.filePath);
        assert.deepEqual(await fixture.call({ action: "release" }), { released: true });
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "applied");
        assert.equal((await fixture.actions.get(fixture.directiveId))?.claimId, undefined);
        assert.equal((await fixture.call({ action: "claim", claimId: "next-host" }) as { claimed: boolean }).claimed, true);
    } finally { await fixture.close(); }
});

test("Reentry a failed Instance report cannot settle and a matching retry recovers", async () => {
    const fixture = await betaReentry();
    try {
        await fixture.call({ action: "claim" });
        await fixture.call({ action: "attempt" });
        const denied = delivery(fixture, fixture.actions, async () => ({ reported: false }));
        assert.deepEqual(await denied({ action: "report", outcome: "accepted" }), { reported: false });
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "reporting");
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationPending, true);
        assert.deepEqual(await fixture.call({ action: "report", outcome: "rejected" }), { reported: false });
        assert.equal((await fixture.call({ action: "report", outcome: "accepted" }) as { reported: boolean }).reported, true);
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationCount, 1);
    } finally { await fixture.close(); }
});

test("Reentry owner rejection clears the Goal without counting a resume and survives restart", async () => {
    const fixture = await betaReentry();
    try {
        await fixture.call({ action: "claim" });
        await fixture.call({ action: "attempt" });
        await fixture.call({ action: "report", outcome: "rejected" });
        const restarted = new McpAppActionStore({ filePath: fixture.filePath });
        await restarted.initialize();
        assert.equal((await restarted.get(fixture.directiveId))?.status, "settled");
        assert.equal((await restarted.get(fixture.directiveId))?.outcome, "rejected");
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationPending, false);
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationCount, 0);
        assert.deepEqual(await delivery(fixture, restarted)({ action: "report", outcome: "accepted" }), { reported: false });
        assert.deepEqual(await delivery(fixture, restarted)({ action: "claim" }), { claimed: false });
    } finally { await fixture.close(); }
});

test("Reentry delayed stale validation cannot restore a replacement owner after reading the old receipt", async () => {
    const fixture = await betaReentry();
    const entered = deferred();
    const resume = deferred();
    try {
        await fixture.call({ action: "claim" });
        const delayed = delivery(fixture, fixture.actions, async (_input, execute) => {
            entered.resolve();
            await resume.promise;
            return execute();
        });
        const validating = delayed({ action: "validate" });
        await entered.promise;
        // Model recovery advancing the durable lifecycle while the old Instance
        // validation is still in transit; the completion must compare ownership.
        await fixture.goal.continuation(fixture.context.ctxId, { action: "release", claimId: fixture.base.claimId });
        assert.equal(await fixture.actions.restoreDelivery(fixture.directiveId, fixture.base.claimId), true);
        assert.ok(await fixture.actions.beginDelivery(fixture.directiveId, "replacement-owner"));
        await fixture.goal.continuation(fixture.context.ctxId, { action: "claim", claimId: "replacement-owner",
            goalId: fixture.base.sourceId, userInitiated: true });
        assert.ok(await fixture.actions.confirmDelivery(fixture.directiveId, "replacement-owner", "replacement-owner"));
        const replacement = await fixture.actions.get(fixture.directiveId);
        resume.resolve();
        assert.equal((await validating as { valid: boolean }).valid, false);
        assert.deepEqual(await fixture.actions.get(fixture.directiveId), replacement);
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationPending, true);
        assert.equal((await fixture.call({ action: "attempt", claimId: "replacement-owner" }) as { attempted: boolean }).attempted, true);
    } finally { resume.resolve(); await fixture.close(); }
});

test("Reentry delayed attempt reply retains its owner because the durable attempt fence prohibits replacement", async () => {
    const fixture = await betaReentry();
    const entered = deferred();
    const resume = deferred();
    try {
        await fixture.call({ action: "claim" });
        const delayed = delivery(fixture, fixture.actions, async (_input, execute) => {
            const result = await execute();
            entered.resolve();
            await resume.promise;
            return result;
        });
        const attempting = delayed({ action: "attempt" });
        await entered.promise;
        await fixture.goal.continuation(fixture.context.ctxId, { action: "retire" });
        assert.equal(await fixture.actions.restoreDelivery(fixture.directiveId, fixture.base.claimId), false);
        assert.equal(await fixture.actions.beginDelivery(fixture.directiveId, "replacement-owner"), undefined);
        const receipt = await fixture.actions.get(fixture.directiveId);
        assert.equal(receipt?.attemptStarted, true);
        assert.equal(receipt?.claimId, fixture.base.claimId);
        resume.resolve();
        assert.equal((await attempting as { attempted: boolean }).attempted, true);
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "attempted");
        assert.deepEqual(await fixture.call({ action: "attempt", claimId: "replacement-owner" }), { attempted: false });
        assert.deepEqual(await fixture.call({ action: "claim", claimId: "replacement-owner" }), { claimed: false });
        assert.deepEqual(await fixture.call({ action: "attempt" }), { attempted: false, duplicate: true });
    } finally { resume.resolve(); await fixture.close(); }
});
