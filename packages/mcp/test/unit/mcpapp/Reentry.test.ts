import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createToolCallRuntime, type JsonValue } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { GoalService } from "../../../../core/src/task/goal/index.ts";
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
    const unregister = installMcpAppReentry(native.hooks, { goal } as never);
    try {
        const ctx = await contexts.registry.create({
            principal: "local", environments: [{ instance: "local", workspace: "/repo" }],
        });
        const started = await goal.manage(ctx.ctxId, {
            action: "start", workspace: "/repo", objective: "Restore task safely",

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
        const view = { async snapshot() {
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

    } finally {
        unregister();
        native.close();
        await contexts.close();
    }
});
