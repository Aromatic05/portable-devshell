import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createToolCallRuntime, type JsonValue } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { GoalService } from "../../../../src/task/goal/index.ts";
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
            return await request.execute(request.callId, request.value.payload, request.value);
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
    assert.ok(created.taskId);
    const runtime = createToolCallRuntime({ resolveTarget: () => ({
        async dispatch(request) {
            assert.ok(request.execute);
            return await request.execute(request.callId, request.value.payload, request.value);
        },
    }) });
    const stop = installMcpAppReentry(runtime.hooks, { todo } as never);
    const call = (ctxId: string, action: string) => runtime.api.call("local", "mcpapp_reentry", {
        action, claimId: "task-claim-123", intent: "task-resume", sourceId: created.taskId,
        ...(action === "report" ? { outcome: "accepted" } : {}),
    }, { ctxId, workspace: "/repo", source: "mcp" });
    try {
        await todo.control(created.taskId, "pause", "ctx-owner", created.revision);
        assert.deepEqual(await call("ctx-owner", "claim"), { claimed: false });
        const paused = (await todo.read()).tasks?.find((item) => item.taskId === created.taskId);
        await todo.control(created.taskId, "resume", "ctx-owner", paused?.revision);
        assert.deepEqual(await call("ctx-other", "claim"), { claimed: false });
        assert.deepEqual(await call("ctx-owner", "claim"), { claimed: true });
        assert.deepEqual(await call("ctx-owner", "validate"), { valid: true });
        assert.deepEqual(await call("ctx-owner", "attempt"), { attempted: true });
        assert.deepEqual(await call("ctx-owner", "report"), { reported: true });
        await todo.control(created.taskId, "cancel", "ctx-owner");
        assert.deepEqual(await call("ctx-owner", "validate"), { valid: false });
    } finally {
        stop();
        runtime.close();
    }
});
