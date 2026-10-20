import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createToolCallRuntime, type JsonValue } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { GoalService } from "../../../../src/task/goal/index.ts";
import { GoalState } from "../../../../src/task/goal/storage/State.ts";
import { TodoService } from "../../../../src/task/todo/index.ts";
import { installMcpAppReentry } from "../../../../src/instance/mcpapp/Reentry.ts";

test("MCPApp Reentry uses Context-owned Goal continuation and fences duplicate delivery", async () => {
    const directory = await createTestTempDirectory("mcpapp-reentry");
    const goal = new GoalService({
        appendEvent: async () => undefined,
        filePath: join(directory, "goals.json"),
        instanceName: "local",
    });
    const created = await goal.manage("ctx-a", {
        action: "start", workspace: "/repo", objective: "Continue work",
        steps: [{ id: "step", text: "Write tests" }],
    });
    assert.ok(created);
    const runtime = createToolCallRuntime({
        resolveTarget: () => ({ async dispatch(request) {
            assert.ok(request.execute);
            return await request.execute(request.callId, request.value.payload, request.value) as JsonValue;
        } }),
    });
    const stop = installMcpAppReentry(runtime.hooks, {
        goal, todo: { read: async () => ({ tasks: [] }) },
    } as never);
    const call = (input: JsonValue, ctxId = "ctx-a", source: "mcp" | "cli" = "mcp") =>
        runtime.api.call("local", "mcpapp_reentry", input, { ctxId, workspace: "/repo", source });
    const base = { claimId: "claim-user-one", sourceId: created.goalId };
    try {
        await assert.rejects(call({ action: "claim", intent: "goal-resume", ...base }, "ctx-b"), /Context and Workspace/u);
        await assert.rejects(call({ action: "claim", intent: "goal-resume", ...base }, "ctx-a", "cli"), /validated Context/u);
        assert.deepEqual(await call({ action: "claim", intent: "automatic", ...base }),
            { claimed: false, goal: await goal.read("ctx-a") });
        const claim = await call({ action: "claim", intent: "goal-resume", ...base }) as { claimed: boolean };
        assert.equal(claim.claimed, true);
        const validation = await call({ action: "validate", ...base }) as { valid: boolean };
        assert.equal(validation.valid, true);
        assert.equal((await call({ action: "attempt", ...base }) as { attempted: boolean }).attempted, true);
        assert.deepEqual(await call({ action: "attempt", ...base }), { attempted: false, duplicate: true });
        assert.deepEqual(await call({ action: "report", outcome: "uncertain", ...base }), { uncertain: true });
        assert.equal((await goal.read("ctx-a"))?.continuationPending, true);
        await call({ action: "report", outcome: "accepted", ...base });
        assert.equal((await goal.read("ctx-a"))?.continuationPending, false);
        assert.equal((await goal.read("ctx-a"))?.continuationCount, 1);
        assert.equal((await call({ action: "validate", ...base }) as { valid: boolean }).valid, false);
    } finally {
        stop();
        runtime.close();
    }
});

test("MCPApp Task recovery requires a resumed Todo in the same Context", async () => {
    const directory = await createTestTempDirectory("mcpapp-todo-reentry");
    const todo = new TodoService({
        appendEvent: async () => undefined,
        filePath: join(directory, "todo.json"), instanceName: "local",
    });
    const created = await todo.write({ revision: 0, title: "Resume task", todos: [
        { id: "work", content: "Work item", status: "in_progress" },
    ] }, "ctx-owner");
    const taskId = created.taskId;
    assert.ok(taskId);
    const runtime = createToolCallRuntime({ resolveTarget: () => ({
        async dispatch(request) {
            assert.ok(request.execute);
            return await request.execute(request.callId, request.value.payload, request.value) as JsonValue;
        },
    }) });
    const stop = installMcpAppReentry(runtime.hooks, { todo } as never);
    const call = (ctxId: string, action: string) => runtime.api.call("local", "mcpapp_reentry", {
        action, claimId: "task-claim-123", intent: "task-resume", sourceId: taskId,
        ...(action === "report" ? { outcome: "accepted" } : {}),
    }, { ctxId, workspace: "/repo", source: "mcp" });
    try {
        await todo.control(taskId, "pause", "ctx-owner", created.revision);
        assert.deepEqual(await call("ctx-owner", "claim"), { claimed: false });
        const paused = (await todo.read()).tasks?.find((item) => item.taskId === taskId);
        await todo.control(taskId, "resume", "ctx-owner", paused?.revision);
        assert.deepEqual(await call("ctx-other", "claim"), { claimed: false });
        assert.deepEqual(await call("ctx-owner", "claim"), { claimed: true });
        assert.deepEqual(await call("ctx-owner", "validate"), { valid: true });
        assert.deepEqual(await call("ctx-owner", "attempt"), { attempted: true });
        assert.deepEqual(await call("ctx-owner", "report"), { reported: true });
        await todo.control(taskId, "cancel", "ctx-owner");
        assert.deepEqual(await call("ctx-owner", "validate"), { valid: false });
    } finally {
        stop();
        runtime.close();
    }
});

async function goalReentry(now?: () => string) {
    const directory = await createTestTempDirectory("reentry-claim-ownership");
    const filePath = join(directory, "goals.json");
    const createGoal = () => new GoalService({ appendEvent: async () => undefined,
        filePath, instanceName: "local", state: new GoalState({ now }) });
    let goal = createGoal();
    const created = await goal.manage("ctx-owner", { action: "start", workspace: "/repo",
        objective: "Recover the same Goal", steps: [{ id: "work", text: "Work" }] });
    assert.ok(created);
    const runtime = createToolCallRuntime({ resolveTarget: () => ({ async dispatch(request) {
        assert.ok(request.execute);
        return await request.execute(request.callId, request.value.payload, request.value) as JsonValue;
    } }) });
    let stop = installMcpAppReentry(runtime.hooks, { goal } as never);
    const base = { claimId: "current-owner", sourceId: created.goalId, intent: "goal-resume" };
    return {
        call: (input: Record<string, JsonValue>) => runtime.api.call("local", "mcpapp_reentry", { ...base, ...input },
            { ctxId: "ctx-owner", workspace: "/repo", source: "mcp" }),
        read: () => goal.read("ctx-owner"),
        restart() { stop(); goal = createGoal(); stop = installMcpAppReentry(runtime.hooks, { goal } as never); },
        close() { stop(); runtime.close(); },
    };
}

test("Reentry Instance uncertain report and duplicate attempt require the active Goal owner", async () => {
    const fixture = await goalReentry();
    try {
        await fixture.call({ action: "claim" });
        await fixture.call({ action: "attempt" });
        const pending = await fixture.read();
        assert.deepEqual(await fixture.call({ action: "report", outcome: "uncertain", claimId: "wrong-token" }), { reported: false });
        assert.deepEqual(await fixture.call({ action: "attempt", claimId: "wrong-token" }), { attempted: false });
        await assert.rejects(fixture.call({ action: "release", claimId: "wrong-token" }), /no longer active/u);
        await assert.rejects(fixture.call({ action: "report", outcome: "accepted", claimId: "wrong-token" }), /no longer active/u);
        await assert.rejects(fixture.call({ action: "report", outcome: "rejected", claimId: "wrong-token" }), /no longer active/u);
        assert.deepEqual(await fixture.read(), pending);
        assert.deepEqual(await fixture.call({ action: "report", outcome: "uncertain" }), { uncertain: true });
        assert.deepEqual(await fixture.read(), pending);
        assert.equal((await fixture.call({ action: "report", outcome: "accepted" }) as { reported: boolean }).reported, true);
        assert.equal((await fixture.read())?.continuationCount, 1);
    } finally { fixture.close(); }
});

test("Reentry Instance uncertain report requires an attempt and does not consume an unattempted claim", async () => {
    const fixture = await goalReentry();
    try {
        await fixture.call({ action: "claim" });
        const pending = await fixture.read();
        assert.deepEqual(await fixture.call({ action: "report", outcome: "uncertain" }), { reported: false });
        assert.deepEqual(await fixture.read(), pending);
        assert.equal((await fixture.call({ action: "attempt" }) as { attempted: boolean }).attempted, true);
        assert.deepEqual(await fixture.call({ action: "report", outcome: "uncertain" }), { uncertain: true });
    } finally { fixture.close(); }
});

test("Reentry Instance serializes concurrent attempts and applied report acknowledgements", async () => {
    const fixture = await goalReentry();
    try {
        const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => fixture.call({ action: "claim", claimId: `owner-${index}` })));
        const winners = claims.map((claim, index) => ({ claimed: (claim as { claimed: boolean }).claimed, index }))
            .filter((entry) => entry.claimed);
        assert.equal(winners.length, 1);
        const claimId = `owner-${winners[0]!.index}`;
        const attempts = await Promise.all(Array.from({ length: 10 }, () => fixture.call({ action: "attempt", claimId })));
        assert.equal(attempts.filter((attempt) => (attempt as { attempted: boolean }).attempted).length, 1);
        assert.equal(attempts.filter((attempt) => (attempt as { duplicate: boolean }).duplicate).length, 9);
        const reports = await Promise.all(Array.from({ length: 10 }, () => fixture.call({ action: "report", outcome: "accepted", claimId })));
        assert.equal(reports.filter((report) => (report as { reported: boolean }).reported).length, 10);
        assert.equal((await fixture.read())?.continuationCount, 1);
        assert.equal((await fixture.read())?.continuationPending, false);
    } finally { fixture.close(); }
});

test("Reentry Instance restart preserves attempted owner and idempotent applied report", async () => {
    const fixture = await goalReentry();
    try {
        await fixture.call({ action: "claim" });
        await fixture.call({ action: "attempt" });
        fixture.restart();
        assert.deepEqual(await fixture.call({ action: "attempt" }), { attempted: false, duplicate: true });
        assert.deepEqual(await fixture.call({ action: "report", outcome: "uncertain", claimId: "crashed-older-owner" }), { reported: false });
        assert.equal((await fixture.read())?.continuationPending, true);
        await fixture.call({ action: "report", outcome: "accepted" });
        fixture.restart();
        assert.deepEqual(await fixture.call({ action: "report", outcome: "accepted" }), { reported: true });
        assert.equal((await fixture.read())?.continuationCount, 1);
    } finally { fixture.close(); }
});

test("Reentry Instance stale claim after crash and expiry cannot release or report a newer pending claim", async () => {
    let clock = Date.parse("2026-10-20T00:00:00.000Z");
    const fixture = await goalReentry(() => new Date(clock).toISOString());
    try {
        await fixture.call({ action: "claim", claimId: "crashed-owner" });
        clock += 6 * 60 * 1000;
        fixture.restart();
        assert.equal((await fixture.call({ action: "claim" }) as { claimed: boolean }).claimed, true);
        assert.equal((await fixture.call({ action: "validate", claimId: "crashed-owner" }) as { valid: boolean }).valid, false);
        await assert.rejects(fixture.call({ action: "release", claimId: "crashed-owner" }), /no longer active/u);
        assert.equal((await fixture.call({ action: "attempt" }) as { attempted: boolean }).attempted, true);
        assert.deepEqual(await fixture.call({ action: "report", outcome: "uncertain", claimId: "crashed-owner" }), { reported: false });
        await assert.rejects(fixture.call({ action: "report", outcome: "accepted", claimId: "crashed-owner" }), /no longer active/u);
        assert.equal((await fixture.read())?.continuationPending, true);
        assert.equal((await fixture.read())?.continuationCount, 0);
        await fixture.call({ action: "report", outcome: "accepted" });
        assert.equal((await fixture.read())?.continuationCount, 1);
    } finally { fixture.close(); }
});
