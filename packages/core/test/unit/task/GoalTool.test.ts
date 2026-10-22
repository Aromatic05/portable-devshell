import assert from "node:assert/strict";
import test from "node:test";
import { createToolCallRuntime, type JsonValue } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { join } from "node:path";
import { GoalService } from "../../../src/task/goal/index.ts";
import { workspaceGoalDefinition } from "../../../src/task/goal/Definition.ts";
import { installWorkspaceGoalTool } from "../../../src/task/goal/Runtime.ts";

test("workspace_goal persists one final objective through the ordinary ToolCall Pipeline", async () => {
    const root = await createTestTempDirectory("workspace-goal-tool-");
    const goal = new GoalService({
        filePath: join(root, "goals.json"), instanceName: "local",
        appendEvent: async () => undefined,
    });
    const reviewed: string[] = [];
    const runtime = createToolCallRuntime({
        resolveTarget: () => ({ async dispatch(request) {
            assert.ok(request.execute);
            return await request.execute(request.callId, request.value.payload, request.value) as JsonValue;
        } }),
    });
    runtime.hooks.registerReview({
        id: "observe-goal", hook: "100-observe-goal",
        review(input) { reviewed.push(input.value.toolName); return { decision: "continue" }; },
    });
    const stop = installWorkspaceGoalTool(runtime.hooks, goal);
    const call = async (args: JsonValue, ctxId = "ctx-a") =>
        await runtime.api.call("local", "workspace_goal", args, {
            ctxId, workspace: root, source: "mcp",
        }) as { goal: { goalId: string; revision: number; status: string; objective: string } | null };
    try {
        assert.equal(workspaceGoalDefinition().name, "workspace_goal");
        assert.equal(workspaceGoalDefinition().group, "workspace");
        assert.deepEqual(await call({ action: "get" }), { goal: null });
        const created = (await call({ action: "start", objective: "Release version 1" })).goal!;
        assert.equal(created.status, "active");
        assert.equal(created.objective, "Release version 1");
        assert.equal("steps" in created, false);
        assert.deepEqual(await call({ action: "get" }, "ctx-b"), { goal: null });
        await assert.rejects(call({ action: "update", note: "Wrong revision", expectedRevision: 99 }), /revision/u);
        const updated = (await call({ action: "update", note: "Tracked in Memory", expectedRevision: created.revision })).goal!;
        assert.equal(updated.status, "active");
        assert.ok(updated.revision > created.revision);
        const completed = (await call({ action: "finish", expectedRevision: updated.revision })).goal!;
        assert.equal(completed.status, "completed");
        assert.equal((await goal.read("ctx-a"))?.status, "completed");
        assert.ok(reviewed.length >= 6);
    } finally {
        stop(); runtime.close();
    }
});
