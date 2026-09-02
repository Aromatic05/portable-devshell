import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue, ToolCallContext, ToolDefinition } from "@portable-devshell/shared";

import {
    AgentWorkerDirectClient,
    type AgentWorkerDirectTransport
} from "../../src/worker/AgentWorkerDirectClient.ts";
import { parseAgentWorkerTarget } from "../../src/target/AgentWorkerTarget.ts";

test("Agent Worker adapter prepares once and binds Agent identity to every tool call", async () => {
    const calls: Array<{
        context: ToolCallContext;
        input: JsonValue;
        toolName: string;
    }> = [];
    const prepared: string[] = [];
    let closed = false;
    const tools: ToolDefinition[] = [{
        description: "Read a file.",
        group: "file",
        inputSchema: { type: "object" },
        name: "file_read",
        outputSchema: { type: "object" },
        requiredCapabilities: ["read"]
    }];
    const directClient: AgentWorkerDirectTransport = {
        async callTool(toolName, input, context) {
            calls.push({ context, input, toolName });
            return { ok: true };
        },
        close() {
            closed = true;
        },
        async listTools() {
            return tools;
        },
        async prepareWorkspace(workspace) {
            prepared.push(workspace);
            return {
                projectMemoryAgentFile: "/repo/AGENTS.md",
                projectMemoryDirectory: "/repo",
                temporaryDirectory: "/tmp/agent",
                workspace
            };
        }
    };
    const target = parseAgentWorkerTarget("worker-a:/repo");
    const client = new AgentWorkerDirectClient({
        agentId: "ag-123",
        directClient,
        target
    });

    assert.equal((await client.listTools())[0]?.name, "file_read");
    await client.callTool("file_read", { path: "README.md" }, { operationId: "pi-call-1" });
    await client.callTool("file_read", { path: "package.json" }, { operationId: "pi-call-2" });

    assert.deepEqual(prepared, ["/repo"]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.context), [
        {
            ctxId: "agent:ag-123",
            requestId: "pi-call-1",
            source: "agent",
            workspace: "/repo"
        },
        {
            ctxId: "agent:ag-123",
            requestId: "pi-call-2",
            source: "agent",
            workspace: "/repo"
        }
    ]);

    await client.close();
    assert.equal(closed, true);
});
