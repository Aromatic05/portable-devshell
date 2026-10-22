import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { GoalState } from "../../../src/task/goal/storage/State.ts";
import { GoalService } from "../../../src/task/goal/index.ts";
import { createGoalTaskRouteModule } from "../../../src/task/goal/Route.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

test("Goal task getGoal only returns the requested Context when Workspaces overlap", async () => {
    const directory = await createTestTempDirectory("goal-context-route");
    const service = new GoalService({
        appendEvent: async () => undefined,
        filePath: join(directory, "goal.json"),
        instanceName: "alpha",
    });
    await service.manage("ctx-a", {
        action: "start", objective: "Authorized goal", workspace: "/shared",

    });
    await service.manage("ctx-b", {
        action: "start", objective: "Other Context secret", workspace: "/shared",

    });
    const route = createGoalTaskRouteModule({
        events: { cursor: () => 14 },
        goal: { list: () => service.list(), read: (ctxId) => service.read(ctxId) },
    });
    const read = route.operations.find((operation) => operation.name === "getGoal")!;
    const result = await read.handle({ id: "read-a", name: "getGoal", payload: { ctxId: "ctx-a" } }, {} as never);
    assert.equal((result as { goal?: { objective: string } }).goal?.objective, "Authorized goal");
    assert.equal(JSON.stringify(result).includes("Other Context secret"), false);
    assert.equal((result as { lastSeq: number }).lastSeq, 14);
    const missing = await read.handle({ id: "read-missing", name: "getGoal", payload: { ctxId: "ctx-empty" } }, {} as never);
    assert.deepEqual(missing, { goal: null, lastSeq: 14 });
    await assert.rejects(() => Promise.resolve(read.handle({ id: "bad", name: "getGoal", payload: {} }, {} as never)), /Context ID/u);
});

test("GoalService stopAll terminalizes every live Goal while preserving completed history", async () => {
    const root = await createTestTempDirectory("goal-stop-all");
    const events: string[] = [];
    const service = new GoalService({
        appendEvent: async (type) => {
            events.push(type);
        },
        filePath: join(root, "goals.json"),
        instanceName: "alpha",
    });
    await service.manage("ctx-active", {
        action: "start",
        objective: "Active goal",

    });
    await service.manage("ctx-blocked", {
        action: "start",
        objective: "Blocked goal",

    });
    await service.manage("ctx-blocked", {
        action: "block",
        note: "Need input",
    });
    await service.manage("ctx-completed", {
        action: "start",
        objective: "Completed goal",

    });
    await service.manage("ctx-completed", { action: "finish" });

    const stopped = await service.stopAll();

    assert.deepEqual(
        stopped.map((goal) => goal.status),
        ["stopped", "stopped"],
    );
    assert.equal((await service.read("ctx-active"))?.status, "stopped");
    assert.equal((await service.read("ctx-blocked"))?.status, "stopped");
    assert.equal((await service.read("ctx-completed"))?.status, "completed");
    assert.equal(
        events.filter((type) => type === "goal.updated").length >= 2,
        true,
    );
});

test("GoalService persists ordinary activity outside the structural Goal document", async () => {
    const root = await createTestTempDirectory("goal-activity-sidecar-");
    const filePath = join(root, "goals.json");
    let now = Date.parse("2026-09-05T10:00:00.000Z");
    const state = new GoalState({ now: () => new Date(now).toISOString() });
    const service = new GoalService({
        appendEvent: async () => undefined,
        filePath,
        instanceName: "alpha",
        state,
    });
    await service.manage("ctx-goal", {
        action: "start",
        objective: "Keep working",

    });
    const structural = await readFile(filePath, "utf8");

    now += 10_000;
    await service.touch("ctx-goal", "execution");
    assert.equal(await readFile(filePath, "utf8"), structural);
    assert.equal(
        (await service.read("ctx-goal"))?.lastExecutionAt,
        "2026-09-05T10:00:10.000Z",
    );

    const reloaded = new GoalService({
        appendEvent: async () => undefined,
        filePath,
        instanceName: "alpha",
        state: new GoalState({ now: () => new Date(now).toISOString() }),
    });
    assert.equal(
        (await reloaded.read("ctx-goal"))?.lastExecutionAt,
        "2026-09-05T10:00:10.000Z",
    );
});

test("GoalService keeps continuation settlement on the structural persistence path", async () => {
    const root = await createTestTempDirectory("goal-activity-structural-");
    const filePath = join(root, "goals.json");
    let now = Date.parse("2026-09-05T11:00:00.000Z");
    const service = new GoalService({
        appendEvent: async () => undefined,
        filePath,
        instanceName: "alpha",
        state: new GoalState({ now: () => new Date(now).toISOString() }),
    });
    await service.manage("ctx-goal", {
        action: "start",
        objective: "Settle continuation",

    });
    await service.continuation("ctx-goal", {
        action: "claim",
        available: true,
        claimId: "claim-1",
        userInitiated: true,
    });
    await service.continuation("ctx-goal", {
        action: "attempt",
        available: true,
        claimId: "claim-1",
    });
    const before = await readFile(filePath, "utf8");

    now += 1_000;
    await service.touch("ctx-goal", "execution");
    assert.notEqual(await readFile(filePath, "utf8"), before);
    const goal = await service.read("ctx-goal");
    assert.equal(goal?.continuationPending, false);
    assert.equal(goal?.continuationCount, 1);
});

test("GoalService falls back to structural persistence when the activity sidecar is unavailable", async () => {
    const root = await createTestTempDirectory("goal-activity-fallback-");
    const filePath = join(root, "goals.json");
    let now = Date.parse("2026-09-05T12:00:00.000Z");
    const service = new GoalService({
        appendEvent: async () => undefined,
        filePath,
        instanceName: "alpha",
        state: new GoalState({ now: () => new Date(now).toISOString() }),
    });
    await service.manage("ctx-goal", {
        action: "start",
        objective: "Fallback",

    });
    const before = await readFile(filePath, "utf8");
    await writeFile(
        join(root, "goals.activity.sqlite3"),
        "not-a-sqlite-database",
        "utf8",
    );

    now += 1_000;
    await service.touch("ctx-goal", "execution");
    assert.notEqual(await readFile(filePath, "utf8"), before);
    assert.equal(
        (await service.read("ctx-goal"))?.lastExecutionAt,
        "2026-09-05T12:00:01.000Z",
    );
});

test("concurrent Goal claims have one owner and a persisted human pause prevents reacquisition", async () => {
    const root = await createTestTempDirectory("goal-claim-pause");
    const filePath = join(root, "goals.json");
    const options = { filePath, instanceName: "alpha", appendEvent: async () => undefined };
    const service = new GoalService(options);
    for (const ctxId of ["ctx-a", "ctx-b"]) {
        await service.manage(ctxId, {
            action: "start", objective: `Goal ${ctxId}`, workspace: "/shared",

        });
    }
    const claim = (claimId: string) => ({
        action: "claim" as const, available: true, userInitiated: true, claimId,
    });
    const claims = await Promise.all([
        service.continuation("ctx-a", claim("app-a")),
        service.continuation("ctx-a", claim("app-b")),
    ]);
    assert.deepEqual(claims.map((result) => (result as { claimed: boolean }).claimed), [true, false]);
    assert.equal((await service.continuation("ctx-b", claim("app-other")) as { claimed: boolean }).claimed, true);
    await service.manage("ctx-a", { action: "pause", userControl: true });
    const restored = new GoalService(options);
    assert.equal((await restored.read("ctx-a"))?.status, "paused");
    assert.equal((await restored.continuation("ctx-a", claim("late-app")) as { claimed: boolean }).claimed, false);
    await assert.rejects(restored.manage("ctx-a", { action: "resume" }), /explicit user resume/u);
    assert.equal((await restored.read("ctx-a"))?.status, "paused");
    assert.equal((await restored.read("ctx-b"))?.continuationPending, true);
    await restored.manage("ctx-a", { action: "resume", userControl: true });
    assert.equal((await restored.continuation("ctx-a", claim("resumed-app")) as { claimed: boolean }).claimed, true);
});
