import assert from "node:assert/strict";
import { join } from "node:path";
import { createToolCallRuntime, type JsonValue } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { GoalService } from "../../../core/src/task/goal/index.ts";
import { mcpAppReentryDefinition } from "../../../core/src/instance/mcpapp/Definition.ts";
import { installMcpAppReentry } from "../../../core/src/instance/mcpapp/Reentry.ts";
import { McpEndpoint } from "../../src/endpoint/Endpoint.ts";
import { McpAppActionStore } from "../../src/mcpapp/ActionStore.ts";
import { createTestContextRuntime } from "../ContextRuntime.ts";
import { TestToolSource } from "./ToolSource.ts";

export async function betaReentry() {
    const directory = await createTestTempDirectory("round3-reentry");
    const contexts = createTestContextRuntime();
    await contexts.initialize();
    let executions = 0;
    let failClaim = false;
    const native = createToolCallRuntime({ resolveTarget: () => ({ async dispatch(request) {
        assert.ok(request.execute);
        executions++;
        if (failClaim && (request.value.payload as { action?: string }).action === "claim") throw new Error("injected dispatch failure");
        return await request.execute(request.callId, request.value.payload, request.value) as JsonValue;
    } }) });
    const goal = new GoalService({ appendEvent: async () => undefined, filePath: join(directory, "goals.json"), instanceName: "local" });
    const uninstall = installMcpAppReentry(native.hooks, { goal } as never);
    const context = await contexts.registry.create({ principal: "owner", environments: [{ instance: "local", workspace: "/repo" }] });
    const started = await goal.manage(context.ctxId, {
        action: "start", workspace: "/repo", objective: "Round three recovery",
    });
    assert.ok(started);
    const filePath = join(directory, "actions.json");
    const actions = new McpAppActionStore({ filePath });
    await actions.initialize();
    const directiveId = "round3-authorized-directive";
    await actions.prepare(context.ctxId, "local", {
        actionId: directiveId, itemId: started.goalId, instance: "local", operation: "goal-resume", targetId: started.goalId, revision: started.revision,
    });
    await actions.apply(directiveId, { kind: "reentry", id: directiveId, intent: "goal-resume", sourceId: started.goalId });
    const source = new TestToolSource();
    source.register("local", [mcpAppReentryDefinition()]);
    const endpoint = (store = actions) => new McpEndpoint({
        context: { resolve: contexts.resolve }, instanceName: "local", toolSource: source, tools: native.api, mcpAppActions: store,
        mcpAppView: { async snapshot() { return {
            presentation: { work: [{ id: started.goalId, title: started.objective }] },
            modelContext: { content: [{ type: "text", text: "Owned model context" }], structuredContent: { ctxId: context.ctxId } },
        }; } } as never,
    });
    const base = { ctxId: context.ctxId, directiveId, intent: "goal-resume", sourceId: started.goalId, claimId: "round3-owner-claim" };
    const call = (input: Record<string, JsonValue>, principal = "owner", target = endpoint()) => target.callTool("mcpapp_reentry", { ...base, ...input }, { principal });
    return { actions, base, call, context, contexts, directiveId, endpoint, filePath, goal, native,
        executions: () => executions, failClaim: (value: boolean) => { failClaim = value; },
        async close() { uninstall(); native.close(); await contexts.close(); },
    };
}
