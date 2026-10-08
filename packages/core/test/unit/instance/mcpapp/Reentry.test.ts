import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createToolCallRuntime, type JsonValue } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { GoalService } from "../../../../src/task/goal/index.ts";
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
    const stop = installMcpAppReentry(runtime.hooks, goal);
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
