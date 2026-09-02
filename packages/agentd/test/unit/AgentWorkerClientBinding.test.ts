import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue, ToolCallContext, ToolDefinition } from "@portable-devshell/shared";

import {
    AgentWorkerClientBinding,
    type AgentWorkerHandle
} from "../../src/worker/AgentWorkerClientBinding.ts";
import { parseAgentWorkerTarget } from "../../src/target/AgentWorkerTarget.ts";

test("Agent Worker binding reuses one handle, prepares once, and releases only its session", async () => {
    const calls: Array<{
        context: ToolCallContext;
        input: JsonValue;
        toolName: string;
    }> = [];
    const prepared: string[] = [];
    const released: string[] = [];
    const tools: ToolDefinition[] = [{
        description: "Read a file.",
        group: "file",
        inputSchema: { type: "object" },
        name: "file_read",
        outputSchema: { type: "object" },
        requiredCapabilities: ["read"]
    }];
    const handle: AgentWorkerHandle = {
        async callTool(toolName, input, context) {
            calls.push({ context, input, toolName });
            return { ok: true };
        },
        listTools() {
            return tools;
        },
        async prepareWorkspace(workspace) {
            prepared.push(workspace);
            return {
                projectMemoryAgentFile: "/repo/AGENTS.md",
                projectMemoryDirectory: "/repo",
                projectMemoryPresent: false,
                temporaryDirectory: "/tmp/agent",
                workspace
            };
        },
        async releaseToolSession(sessionId) {
            released.push(sessionId);
        }
    };
    const target = parseAgentWorkerTarget("worker-a:/repo");
    const client = new AgentWorkerClientBinding({
        agentId: "ag-123",
        handle,
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
    assert.deepEqual(released, ["agent:ag-123"]);
});
