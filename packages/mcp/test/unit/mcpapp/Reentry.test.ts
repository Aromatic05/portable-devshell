import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createToolCallRuntime, type JsonValue } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { GoalService } from "../../../../core/src/task/goal/index.ts";
import { TodoService } from "../../../../core/src/task/todo/index.ts";
import { mcpAppReentryDefinition } from "../../../../core/src/instance/mcpapp/Definition.ts";
import { installMcpAppReentry } from "../../../../core/src/instance/mcpapp/Reentry.ts";
import { McpEndpoint } from "../../../src/endpoint/Endpoint.ts";
import { McpAppActionStore } from "../../../src/mcpapp/ActionStore.ts";
import { createTestContextRuntime } from "../../ContextRuntime.ts";
import { TestToolSource } from "../../support/ToolSource.ts";

test("MCPApp Reentry binds durable Goal recovery through Instance ToolCall and settles only after Host report", async () => {
    const directory = await createTestTempDirectory("mcpapp-host-reentry");
    const contexts = createTestContextRuntime();
    await contexts.initialize();
    const native = createToolCallRuntime({ resolveTarget: () => ({
        async dispatch(request) {
            assert.ok(request.execute);
            return await request.execute(request.callId, request.value.payload, request.value) as JsonValue;
        },
    }) });
    const goal = new GoalService({
        appendEvent: async () => undefined,
        filePath: join(directory, "goals.json"), instanceName: "local",
    });
    const todo = new TodoService({
        appendEvent: async () => undefined,
        filePath: join(directory, "todo.json"), instanceName: "local",
    });
    const unregister = installMcpAppReentry(native.hooks, { goal, todo } as never);
    try {
        const ctx = await contexts.registry.create({
            principal: "local", environments: [{ instance: "local", workspace: "/repo" }],
        });
        const started = await goal.manage(ctx.ctxId, {
            action: "start", workspace: "/repo", objective: "Restore task safely",
            steps: [{ id: "work", text: "Resume work" }],
        });
        assert.ok(started);
        const receipts = new McpAppActionStore({ filePath: join(directory, "actions.json") });
        await receipts.initialize();
        await receipts.prepare(ctx.ctxId, "local", {
            actionId: "authorized-resume-receipt", itemId: started.goalId,
            instance: "local", operation: "goal-resume", targetId: started.goalId,
            revision: started.revision,
        });
        await receipts.apply("authorized-resume-receipt", {
            kind: "reentry", id: "authorized-resume-receipt", intent: "goal-resume", sourceId: started.goalId,
        });
        const source = new TestToolSource();
        source.register("local", [mcpAppReentryDefinition()]);
        let projectionUnavailable = false;
        const view = { async snapshot() {
            if (projectionUnavailable) throw new Error("model context projection unavailable");
            return {
            presentation: { work: [{ id: started.goalId, title: started.objective }] },
            modelContext: {
                content: [{ type: "text", text: "Context-owned state" }],
                structuredContent: { portableDevshellMcpApp: { ctxId: ctx.ctxId, goalId: started.goalId } },
            },
        }; } };
        const endpoint = new McpEndpoint({
            context: { resolve: contexts.resolve },
            instanceName: "local", toolSource: source, tools: native.api,
            mcpAppActions: receipts, mcpAppView: view as never,
        });
        const base = {
            ctxId: ctx.ctxId, claimId: "claim-user-resume-1", directiveId: "authorized-resume-receipt",
            intent: "goal-resume", sourceId: started.goalId,
        };
        const call = (data: Record<string, unknown>, principal = "local") =>
            endpoint.callTool("mcpapp_reentry", { ...base, ...data }, { principal });
        await assert.rejects(call({ action: "claim", intent: "goal-resume", sourceId: started.goalId }, "not-owner"));
        const claim = await call({ action: "claim", intent: "goal-resume", sourceId: started.goalId }) as {
            claimed: boolean; delivery: { message: string; modelContext: unknown };
        };
        assert.equal(claim.claimed, true);
        assert.match(claim.delivery.message, /Restore task safely/u);
        assert.equal(JSON.stringify(claim.delivery.modelContext).includes(ctx.ctxId), true);
        assert.equal((await receipts.get(base.directiveId))?.status, "attempting");
        assert.deepEqual(await call({ action: "claim", intent: "goal-resume", sourceId: started.goalId }), { claimed: false });
        assert.equal((await call({ action: "validate" }) as { valid: boolean }).valid, true);
        assert.equal((await call({ action: "attempt" }) as { attempted: boolean }).attempted, true);
        assert.equal((await receipts.get(base.directiveId))?.status, "attempted");
        assert.equal((await call({ action: "attempt" }) as { duplicate: boolean }).duplicate, true);
        await call({ action: "report", outcome: "accepted" });
        assert.equal((await receipts.get(base.directiveId))?.status, "settled");
        assert.deepEqual(await receipts.pendingDirectives(ctx.ctxId, "local"), []);
        assert.equal((await goal.read(ctx.ctxId))?.continuationCount, 1);

        const createdTask = await todo.write({ revision: 0, title: "Resume background work", todos: [
            { id: "item", content: "Continue", status: "in_progress" },
        ] }, ctx.ctxId);
        assert.ok(createdTask.taskId);
        await todo.control(createdTask.taskId, "pause", ctx.ctxId, createdTask.revision);
        await todo.control(createdTask.taskId, "resume", ctx.ctxId);
        await receipts.prepare(ctx.ctxId, "local", {
            actionId: "authorized-task-receipt", itemId: createdTask.taskId,
            instance: "local", operation: "task-resume", targetId: createdTask.taskId,
        });
        await receipts.apply("authorized-task-receipt", {
            kind: "reentry", id: "authorized-task-receipt", intent: "task-resume", sourceId: createdTask.taskId,
        });
        const taskBase = {
            ctxId: ctx.ctxId, claimId: "claim-task-resume-1", directiveId: "authorized-task-receipt",
            intent: "task-resume", sourceId: createdTask.taskId,
        };
        const taskCall = (data: Record<string, unknown>) =>
            endpoint.callTool("mcpapp_reentry", { ...taskBase, ...data }, { principal: "local" });
        const taskClaim = await taskCall({ action: "claim" }) as { claimed: boolean; delivery: { message: string } };
        assert.equal(taskClaim.claimed, true);
        assert.match(taskClaim.delivery.message, /workspace Task/u);
        assert.deepEqual(await taskCall({ action: "report", outcome: "accepted" }), { reported: false });
        assert.equal((await receipts.get("authorized-task-receipt"))?.status, "attempting");
        assert.equal((await taskCall({ action: "validate" }) as { valid: boolean }).valid, true);
        assert.equal((await taskCall({ action: "attempt" }) as { attempted: boolean }).attempted, true);
        assert.deepEqual(await taskCall({ action: "attempt" }), { attempted: false, duplicate: true });
        await taskCall({ action: "report", outcome: "accepted" });
        assert.equal((await receipts.get("authorized-task-receipt"))?.status, "settled");
        assert.deepEqual(await receipts.pendingDirectives(ctx.ctxId, "local"), []);

        await receipts.prepare(ctx.ctxId, "local", {
            actionId: "projection-failure-receipt", itemId: createdTask.taskId,
            instance: "local", operation: "task-resume", targetId: createdTask.taskId,
        });
        await receipts.apply("projection-failure-receipt", {
            kind: "reentry", id: "projection-failure-receipt", intent: "task-resume", sourceId: createdTask.taskId,
        });
        projectionUnavailable = true;
        await assert.rejects(endpoint.callTool("mcpapp_reentry", {
            ...taskBase, action: "claim", claimId: "projection-failure-claim",
            directiveId: "projection-failure-receipt",
        }, { principal: "local" }), /model context projection unavailable/u);
        projectionUnavailable = false;
        assert.equal((await receipts.get("projection-failure-receipt"))?.status, "applied");
    } finally {
        unregister();
        native.close();
        await contexts.close();
    }
});
