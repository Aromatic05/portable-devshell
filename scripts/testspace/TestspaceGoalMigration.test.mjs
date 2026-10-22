import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

import { createSafeAction, runConnectorLoop } from "./TestspaceConnector.mjs";

const { GoalService } = await tsImport("../../packages/core/src/task/goal/index.ts", { parentURL: import.meta.url });

async function goalFixture(t) {
    const directory = await mkdtemp(join(tmpdir(), "testspace-goal-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const events = [];
    const reopen = () => new GoalService({
        filePath: join(directory, "goals.json"),
        instanceName: "testspace-local",
        appendEvent: async (type, data) => { events.push({ type, data }); },
    });
    return { directory, events, reopen };
}

test("Goal activity uses the server identity and revision without resuming a user-paused Goal", () => {
    assert.deepEqual(createSafeAction("workspace_goal", { ctxId: "ctx-a", iteration: 9 }),
        { name: "workspace_goal", arguments: { ctxId: "ctx-a", action: "get" } });
    assert.deepEqual(createSafeAction("workspace_goal", {
        ctxId: "ctx-a", iteration: 7, goal: { goalId: "goal-a", revision: 3, status: "active" },
    }), { name: "workspace_goal", arguments: {
        ctxId: "ctx-a", action: "update", expectedGoalId: "goal-a", expectedRevision: 3,
        note: "Connector activity iteration 7; inspect actual ToolCalls in TUI Audit and Web.",
    } });
    assert.deepEqual(createSafeAction("workspace_goal", {
        ctxId: "ctx-a", iteration: 8, goal: { goalId: "goal-a", revision: 4, status: "paused" },
    }), { name: "workspace_goal", arguments: { ctxId: "ctx-a", action: "get" } });
});

test("Connector rereads a committed Goal after a lost update reply before sending the next revision", async (t) => {
    const { directory, reopen } = await goalFixture(t);
    let service = reopen();
    const calls = [];
    let connections = 0;
    let clock = 0;
    t.mock.method(Date, "now", () => { clock += 40_000; return clock; });
    const logFile = join(directory, "activity.jsonl");
    await runConnectorLoop({
        endpoint: "http://127.0.0.1:19000/testspace-local/mcp",
        instance: "testspace-local", workspace: directory,
        logFile, intervalMs: 0, maxIterations: 2,
        connectClient: async () => {
            connections += 1;
            service = reopen();
            return {
                ctxId: "ctx-a", toolNames: new Set(["workspace_goal"]),
                client: {
                    async callTool({ name, arguments: input }) {
                        assert.equal(name, "workspace_goal");
                        assert.equal(input.ctxId, "ctx-a");
                        calls.push(input.action);
                        const { ctxId, ...mutation } = input;
                        const goal = input.action === "get" ? await service.read(ctxId)
                            : await service.manage(ctxId, { ...mutation, workspace: directory });
                        // Simulate a real weak-network chain: commit succeeds, reply is lost.
                        if (calls.length === 3) throw new Error("Goal update reply lost");
                        return { structuredContent: { goal: goal ?? null } };
                    },
                    async close() {},
                },
            };
        },
    });
    assert.equal(connections, 2);
    assert.deepEqual(calls, ["get", "start", "update", "get", "update"]);
    const goal = await reopen().read("ctx-a");
    assert.equal(goal.status, "active");
    assert.equal(goal.revision, 3);
    assert.match(goal.note, /iteration 2/u);
    const logs = (await readFile(logFile, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(logs.filter((entry) => entry.event === "testspace.goal.seeded").length, 1);
    assert.equal(logs.filter((entry) => entry.event === "connector.error").length, 1);
    assert.equal(logs.find((entry) => entry.event === "tool.result").isError, false);
});

test("Context Goal objective, blocker, activity and revision survive repeated service lifetimes", async (t) => {
    const { directory, events, reopen } = await goalFixture(t);
    const service = reopen();
    const started = await service.manage("ctx-a", { action: "start", workspace: directory,
        objective: "Verify durable Goal recovery" });
    const updated = await service.manage("ctx-a", { action: "update", expectedGoalId: started.goalId,
        expectedRevision: started.revision, note: "Real persisted activity" });
    await service.touch("ctx-a", "execution");
    const before = await service.read("ctx-a");
    assert.equal(before.revision, updated.revision);
    assert.deepEqual(await reopen().read("ctx-a"), before);
    assert.equal(await reopen().read("ctx-other"), undefined);
    const recovered = reopen();
    await assert.rejects(recovered.manage("ctx-a", { action: "update", expectedRevision: started.revision,
        note: "Stale revision must fail" }), /changed from revision/u);
    assert.deepEqual(await recovered.read("ctx-a"), before);
    const blocked = await recovered.manage("ctx-a", { action: "block", note: "Awaiting recovery verification",
        expectedGoalId: before.goalId, expectedRevision: before.revision });
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(await reopen().read("ctx-a"), blocked);
    const finished = await reopen().manage("ctx-a", { action: "finish", expectedGoalId: blocked.goalId,
        expectedRevision: blocked.revision });
    assert.equal(finished.status, "completed");
    assert.deepEqual(await reopen().read("ctx-a"), finished);
    assert.ok(events.length >= 5);
    assert.deepEqual([...new Set(events.map((event) => event.type))], ["goal.updated"]);
});

test("Connector paces Goal activity while continuing ordinary audited tool activity", async (t) => {
    const { directory, reopen } = await goalFixture(t);
    const service = reopen();
    const calls = [];
    t.mock.method(Date, "now", () => 1_000);
    await runConnectorLoop({
        endpoint: "http://127.0.0.1:19000/testspace-local/mcp",
        instance: "testspace-local", workspace: directory,
        logFile: join(directory, "activity.jsonl"), intervalMs: 0, maxIterations: 2,
        connectClient: async () => ({
            ctxId: "ctx-paced", toolNames: new Set(["workspace_goal", "bash_run"]),
            client: {
                async callTool({ name, arguments: input }) {
                    calls.push({ name, input });
                    if (name === "bash_run") return { structuredContent: { exitCode: 0 } };
                    const { ctxId, ...mutation } = input;
                    const goal = mutation.action === "get" ? await service.read(ctxId)
                        : await service.manage(ctxId, { ...mutation, workspace: directory });
                    return { structuredContent: { goal: goal ?? null } };
                },
                async close() {},
            },
        }),
    });
    assert.deepEqual(calls.map((call) => call.name), ["workspace_goal", "workspace_goal", "bash_run", "bash_run"]);
    assert.deepEqual(calls.slice(0, 2).map((call) => call.input.action), ["get", "start"]);
    assert.equal((await reopen().read("ctx-paced")).revision, 1);
});
