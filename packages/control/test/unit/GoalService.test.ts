import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { GoalState } from "../../src/instance/goal/GoalState.ts";
import { GoalService } from "../../src/instance/goal/GoalService.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("GoalService stopAll terminalizes every live Goal while preserving completed history", async () => {
    const root = await createTestTempDirectory("goal-stop-all");
    const events: string[] = [];
    const service = new GoalService({
        appendEvent: async (type) => { events.push(type); },
        filePath: join(root, "goals.json"),
        instanceName: "alpha",
    });
    await service.manage("ctx-active", {
        action: "start",
        objective: "Active goal",
        steps: [{ id: "active", text: "Continue" }],
    });
    await service.manage("ctx-blocked", {
        action: "start",
        objective: "Blocked goal",
        steps: [{ id: "blocked", text: "Wait" }],
    });
    await service.manage("ctx-blocked", { action: "block", note: "Need input" });
    await service.manage("ctx-completed", {
        action: "start",
        objective: "Completed goal",
        steps: [{ id: "done", status: "completed", text: "Done" }],
    });

    const stopped = await service.stopAll();

    assert.deepEqual(stopped.map((goal) => goal.status), ["stopped", "stopped"]);
    assert.equal((await service.read("ctx-active"))?.status, "stopped");
    assert.equal((await service.read("ctx-blocked"))?.status, "stopped");
    assert.equal((await service.read("ctx-completed"))?.status, "completed");
    assert.equal(events.filter((type) => type === "goal.updated").length >= 2, true);
});

test("GoalService persists ordinary activity outside the structural Goal document", async () => {
    const root = await createTestTempDirectory("goal-activity-sidecar-");
    const filePath = join(root, "goals.json");
    let now = Date.parse("2026-09-05T10:00:00.000Z");
    const state = new GoalState({ now: () => new Date(now).toISOString() });
    const service = new GoalService({ appendEvent: async () => undefined, filePath, instanceName: "alpha", state });
    await service.manage("ctx-goal", {
        action: "start",
        objective: "Keep working",
        steps: [{ id: "work", text: "Work" }],
    });
    const structural = await readFile(filePath, "utf8");

    now += 10_000;
    await service.touch("ctx-goal", "execution");
    assert.equal(await readFile(filePath, "utf8"), structural);
    assert.equal((await service.read("ctx-goal"))?.lastExecutionAt, "2026-09-05T10:00:10.000Z");

    const reloaded = new GoalService({
        appendEvent: async () => undefined,
        filePath,
        instanceName: "alpha",
        state: new GoalState({ now: () => new Date(now).toISOString() }),
    });
    assert.equal((await reloaded.read("ctx-goal"))?.lastExecutionAt, "2026-09-05T10:00:10.000Z");
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
        steps: [{ id: "work", text: "Work" }],
    });
    await service.continuation("ctx-goal", {
        action: "claim",
        available: true,
        claimId: "claim-1",
        userInitiated: true,
    });
    await service.continuation("ctx-goal", { action: "attempt", available: true, claimId: "claim-1" });
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
        steps: [{ id: "work", text: "Work" }],
    });
    const before = await readFile(filePath, "utf8");
    await writeFile(join(root, "goals.activity.sqlite3"), "not-a-sqlite-database", "utf8");

    now += 1_000;
    await service.touch("ctx-goal", "execution");
    assert.notEqual(await readFile(filePath, "utf8"), before);
    assert.equal((await service.read("ctx-goal"))?.lastExecutionAt, "2026-09-05T12:00:01.000Z");
});
