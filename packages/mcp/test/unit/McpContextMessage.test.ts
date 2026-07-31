import assert from "node:assert/strict";
import test from "node:test";

import { McpEndpointHandlerContextMessage } from "../../src/endpoint/handler/McpEndpointHandlerContextMessage.ts";
import { McpToolCatalogContextMessage } from "../../src/tool/catalog/McpToolCatalogContextMessage.ts";

test("context_message_read is exposed as a context-scoped control tool", () => {
    const [tool] = new McpToolCatalogContextMessage().list();
    assert.equal(tool?.name, "context_message_read");
    assert.deepEqual(tool?.requiredCapabilities, []);
});

test("context_message_read delivers messages only through the validated ctxId", async () => {
    const calls: Array<{ ctxId: string; instance: string }> = [];
    const handler = new McpEndpointHandlerContextMessage({
        gateway: {
            readContextMessages: async (instance, ctxId) => {
                calls.push({ ctxId, instance });
                return { messages: [{ createdAt: "2026-07-31T00:00:00.000Z", id: "message-1", text: "Review the failure" }] };
            }
        } as never,
        instanceName: "alpha"
    });

    const result = await handler.call(
        "context_message_read",
        {},
        { ctxId: "ctx-a", source: "mcp" }
    );

    assert.deepEqual(calls, [{ ctxId: "ctx-a", instance: "alpha" }]);
    assert.deepEqual(result, {
        messages: [{ createdAt: "2026-07-31T00:00:00.000Z", id: "message-1", text: "Review the failure" }]
    });
});
