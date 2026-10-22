import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { asInstanceName, type ToolCallApi } from "@portable-devshell/shared";
import { mcpAppActionDefinition } from "../../../../core/src/instance/mcpapp/Definition.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { McpEndpoint } from "../../../src/endpoint/Endpoint.ts";
import { McpAppActionStore } from "../../../src/mcpapp/ActionStore.ts";
import { createTestContextRuntime } from "../../ContextRuntime.ts";
import { TestToolSource } from "../../support/ToolSource.ts";

test("MCPApp Action receipt replays only an applied result, never its Instance execution", async () => {
    const directory = await createTestTempDirectory("mcpapp-receipt");
    const filePath = join(directory, "actions.json");
    const contexts = createTestContextRuntime();
    await contexts.initialize();
    try {
        const record = await contexts.registry.create({
            principal: "local", environments: [{ instance: "local", workspace: "/repo" }],
        });
        const source = new TestToolSource();
        source.register("local", [mcpAppActionDefinition()]);
        let mutations = 0;
        const transport = { resolve: contexts.resolve };
        const tools: ToolCallApi = {
            async call(instance, toolName, input, context, _signal, transformResult, invocationInput) {
                assert.equal(instance, "local");
                assert.equal(toolName, "mcpapp_action");
                assert.equal(context.ctxId, record.ctxId);
                await invocationInput?.(input, "test-toolcall", {
                    kind: "call", payload: input, toolName,
                    context: { ...context, instance: asInstanceName(instance) },
                });
                mutations++;
                const result = { status: "applied", itemId: (input as { itemId: string }).itemId,
                    actionId: (input as { actionId: string }).actionId };
                await transformResult?.(result, "test-toolcall");
                return result;
            },
        };
        const store = new McpAppActionStore({ filePath });
        await store.initialize();
        const endpoint = (actions: McpAppActionStore) => new McpEndpoint({
            context: transport,
            instanceName: "local",
            toolSource: source,
            tools,
            mcpAppActions: actions,
        });
        const call = (target: McpEndpoint, itemId = "goal-a", principal = "local", requestId = "same-action-request-1234") =>
            target.callTool("mcpapp_action", {
                ctxId: record.ctxId, itemId, actionId: "goal-pause", expectedRevision: 3, requestId,
            }, { principal });
        const first = endpoint(store);
        const [a, b] = await Promise.all([call(first), call(first)]);
        assert.deepEqual(a, { status: "applied", itemId: "goal-a", actionId: "goal-pause" });
        assert.deepEqual(b, a);
        assert.equal(mutations, 1);
        assert.deepEqual(await call(first), a);
        assert.equal(mutations, 1);

        const restarted = new McpAppActionStore({ filePath });
        await restarted.initialize();
        assert.deepEqual(await call(endpoint(restarted)), a);
        assert.equal(mutations, 1);

        await assert.rejects(call(endpoint(restarted), "goal-b"), /conflicts/u);
        await assert.rejects(call(first, "goal-a", "not-owner"));
        assert.equal(mutations, 1);

        // Different request identity is a new deliberate user action.
        await call(first, "goal-a", "local", "second-action-request-5678");
        assert.equal(mutations, 2);

        // A second endpoint has its own in-flight map; the shared store must
        // reserve the request atomically before either can execute it.
        const concurrent = await Promise.all([
            call(first, "goal-a", "local", "third-action-request-9012"),
            call(endpoint(store), "goal-a", "local", "third-action-request-9012"),
        ]);
        assert.equal(mutations, 3);
        assert.equal(concurrent.some((value) => (value as { status: string }).status === "applied"), true);
        assert.equal(concurrent.every((value) => ["applied", "stale"].includes((value as { status: string }).status)), true);
    } finally {
        await contexts.close();
    }
});
