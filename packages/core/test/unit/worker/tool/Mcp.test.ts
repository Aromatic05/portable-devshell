import assert from "node:assert/strict";
import test from "node:test";

import { mcpTools } from "@portable-devshell/mcp/tool";
import type { ToolDefinition } from "@portable-devshell/shared";
import { WorkerMcpToolRegistration } from "../../../../src/worker/tool/Mcp.ts";

const definition: ToolDefinition = {
    description: "Run shell",
    group: "bash",
    inputSchema: { type: "object" },
    name: "bash_run",
    outputSchema: { type: "object" },
    requiredCapabilities: ["execute"],
};

test("Worker MCP registration publishes and disposes one instance schema", () => {
    const instance = "worker-mcp-registration-test";
    const registration = new WorkerMcpToolRegistration(instance);
    try {
        assert.deepEqual(mcpTools.list(instance), []);
        registration.replace([definition]);
        assert.equal(
            mcpTools.get(instance, definition.name)?.definition.name,
            definition.name,
        );
    } finally {
        registration.dispose();
    }
    assert.deepEqual(mcpTools.list(instance), []);
});
