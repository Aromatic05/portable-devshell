import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { GoalService } from "../../../src/task/goal/index.ts";
import { GoalState } from "../../../src/task/goal/storage/State.ts";

const eio = () => Object.assign(new Error("injected EIO"), { code: "EIO" });

test("structural rename failure reloads already committed Goal activity", async (t) => {
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const root = await createTestTempDirectory("goal-activity-rename-");
    const filePath = join(root, "goals.json");
    let now = "2026-10-24T12:00:00.000Z";
    const options = {
        filePath, instanceName: "alpha", appendEvent: async () => undefined,
        state: new GoalState({ now: () => now }),
    };
    const service = new GoalService(options);
    await service.manage("ctx-a", { action: "start", objective: "Persist heartbeat" });
    now = "2026-10-24T12:00:01.000Z";
    await service.touch("ctx-a", "execution");
    const before = (await service.read("ctx-a"))?.lastExecutionAt;
    assert.equal(before, now);
    t.mock.method(fs.promises, "rename", async () => { throw eio(); });
    syncBuiltinESMExports();
    await assert.rejects(service.manage("ctx-a", { action: "update", note: "not committed" }), { code: "EIO" });
    assert.equal((await service.read("ctx-a"))?.lastExecutionAt, before);
    assert.equal((await new GoalService(options).read("ctx-a"))?.lastExecutionAt, before);
});

test("same-millisecond SQLite activity reloads and never overrides a newer structure", async () => {
    const root = await createTestTempDirectory("goal-same-ms-");
    const filePath = join(root, "goals.json");
    const now = "2026-10-24T12:00:00.000Z";
    const options = {
        filePath, instanceName: "alpha", appendEvent: async () => undefined,
        state: new GoalState({ now: () => now }),
    };
    const service = new GoalService(options);
    await service.manage("ctx-a", { action: "start", objective: "Same millisecond" });
    await service.touch("ctx-a", "execution");
    assert.equal((await service.read("ctx-a"))?.lastExecutionAt, now);
    assert.equal((await new GoalService(options).read("ctx-a"))?.lastExecutionAt, now);
    const document = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    document.goals[0].objective = "Newer structural revision";
    await fs.promises.writeFile(filePath, JSON.stringify(document));
    assert.equal((await new GoalService(options).read("ctx-a"))?.lastExecutionAt, undefined);
});

test("wall-clock rollback does not discard later Activity writes", async () => {
    const root = await createTestTempDirectory("goal-clock-rollback-");
    const filePath = join(root, "goals.json");
    let now = "2026-10-24T12:00:00.000Z";
    const options = {
        filePath, instanceName: "alpha", appendEvent: async () => undefined,
        state: new GoalState({ now: () => now }),
    };
    const service = new GoalService(options);
    await service.manage("ctx-a", { action: "start", objective: "Clock rollback" });
    now = "2026-10-24T11:59:59.000Z";
    await service.touch("ctx-a", "execution");
    assert.equal((await new GoalService(options).read("ctx-a"))?.lastExecutionAt, now);
});

test("transient Sidecar read failure never declares an overdue Goal and recovers in the same service", {
    skip: process.platform === "win32",
}, async (t) => {
    const root = await createTestTempDirectory("goal-sidecar-recovery-");
    const filePath = join(root, "goals.json");
    const sidecar = join(root, "goals.activity.sqlite3");
    let now = "2026-10-25T00:00:00.000Z";
    const options = {
        filePath, instanceName: "alpha", appendEvent: async () => undefined,
        state: new GoalState({ now: () => now }),
    };
    const initial = new GoalService(options);
    await initial.manage("ctx-a", { action: "start", objective: "Do not resume early" });
    now = "2026-10-25T00:00:30.000Z";
    await initial.touch("ctx-a", "execution");
    now = "2026-10-25T00:01:05.000Z";
    await fs.promises.chmod(sidecar, 0);
    t.after(async () => await fs.promises.chmod(sidecar, 0o600));
    const recovered = new GoalService(options);
    await assert.rejects(recovered.read("ctx-a"), /unable to open database|permission|SQLITE_CANTOPEN/ui);
    await fs.promises.chmod(sidecar, 0o600);
    const goal = await recovered.read("ctx-a");
    assert.equal(goal?.lastExecutionAt, "2026-10-25T00:00:30.000Z");
    assert.equal(goal?.continuationDue, false);
    assert.equal(goal?.continuationDueAt, "2026-10-25T00:01:30.000Z");
});

test("a structural fallback heartbeat is not overwritten by older Sidecar activity after recovery", {
    skip: process.platform === "win32",
}, async (t) => {
    const root = await createTestTempDirectory("goal-fallback-causality-");
    const filePath = join(root, "goals.json");
    const sidecar = join(root, "goals.activity.sqlite3");
    let now = "2026-10-25T00:00:00.000Z";
    const options = {
        filePath, instanceName: "alpha", appendEvent: async () => undefined,
        state: new GoalState({ now: () => now }),
    };
    const service = new GoalService(options);
    await service.manage("ctx-a", { action: "start", objective: "Structural fallback wins" });
    now = "2026-10-25T00:00:10.000Z";
    await service.touch("ctx-a", "execution");
    await fs.promises.chmod(sidecar, 0);
    t.after(async () => await fs.promises.chmod(sidecar, 0o600));
    now = "2026-10-25T00:00:20.000Z";
    await service.touch("ctx-a", "execution");
    await fs.promises.chmod(sidecar, 0o600);
    const restored = new GoalService(options);
    assert.equal((await restored.read("ctx-a"))?.lastExecutionAt, now);
    assert.equal((await service.read("ctx-a"))?.lastExecutionAt, now);
    now = "2026-10-25T00:00:21.000Z";
    await service.touch("ctx-a", "execution");
    assert.equal((await new GoalService(options).read("ctx-a"))?.lastExecutionAt, now,
        "Sidecar must become writable again after a transient failure");
});

test("older Activity SQLite tables are upgraded without discarding rows", async () => {
    const root = await createTestTempDirectory("goal-activity-schema-");
    const filePath = join(root, "goals.json");
    const options = {
        filePath, instanceName: "alpha", appendEvent: async () => undefined,
        state: new GoalState({ now: () => "2026-10-24T12:00:00.000Z" }),
    };
    const service = new GoalService(options);
    await service.manage("ctx-a", { action: "start", objective: "Keep old sidecar" });
    const goalId = JSON.parse(await fs.promises.readFile(filePath, "utf8")).goals[0].goalId as string;
    const db = new DatabaseSync(join(root, "goals.activity.sqlite3"));
    try {
        db.exec(`CREATE TABLE goal_activity (
            goal_id TEXT PRIMARY KEY,
            last_agent_activity_at TEXT NOT NULL,
            last_execution_at TEXT,
            no_action_streak INTEGER NOT NULL
        ) STRICT;`);
        db.prepare("INSERT INTO goal_activity VALUES (?, ?, ?, ?)").run(
            goalId, "2026-10-24T12:00:01.000Z", "2026-10-24T12:00:01.000Z", 0,
        );
    } finally {
        db.close();
    }
    assert.equal((await new GoalService(options).read("ctx-a"))?.lastExecutionAt,
        "2026-10-24T12:00:01.000Z");
});
