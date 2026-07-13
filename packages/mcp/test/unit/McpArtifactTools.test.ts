import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue, ToolCallContext, ToolDefinition } from "@portable-devshell/shared";
import { McpEndpointWorker, type McpInstanceGateway } from "@portable-devshell/mcp";

const context: ToolCallContext = { source: "mcp", sessionId: "session-1" };

const artifactRead: ToolDefinition = {
    description: "Read an artifact payload.",
    group: "artifact",
    inputSchema: { type: "object" },
    name: "artifact_read",
    outputSchema: { type: "object" },
    requiredCapabilities: ["read"]
};

test("artifact endpoint exposes worker read plus control share and transfer while worker is stopped", async () => {
    const calls: Array<{ kind: string; defaultInstance: string; input: JsonValue }> = [];
    const gateway = createGateway({
        async shareArtifact(defaultInstance, input) {
            calls.push({ defaultInstance, input: input as unknown as JsonValue, kind: "share" });
            return { shareId: "share-1" };
        },
        async transferArtifact(defaultInstance, input) {
            calls.push({ defaultInstance, input: input as unknown as JsonValue, kind: "transfer" });
            return { transferId: "transfer-1" };
        }
    });
    const endpoint = new McpEndpointWorker({
        gateway,
        instanceName: "main-pc",
        policy: { capabilities: ["read", "write"], groups: ["artifact"] },
        worker: createWorker(false, true)
    });

    assert.deepEqual(endpoint.listTools().map((tool) => tool.name), [
        "artifact_read",
        "artifact_share",
        "artifact_transfer"
    ]);
    assert.deepEqual(await endpoint.callTool("artifact_share", { path: "./dist" }, context), {
        shareId: "share-1"
    });
    assert.deepEqual(
        await endpoint.callTool(
            "artifact_transfer",
            {
                operation: "start",
                sourcePath: "./dist",
                targetInstance: "remote-server",
                targetPath: "/srv/app"
            },
            context
        ),
        { transferId: "transfer-1" }
    );
    assert.deepEqual(calls, [
        { defaultInstance: "main-pc", input: { path: "./dist" }, kind: "share" },
        {
            defaultInstance: "main-pc",
            input: {
                operation: "start",
                overwrite: false,
                sourcePath: "./dist",
                targetInstance: "remote-server",
                targetPath: "/srv/app"
            },
            kind: "transfer"
        }
    ]);
});

test("artifact control tools require artifact group and read/write capabilities", () => {
    const gateway = createGateway({
        async shareArtifact() { return {}; },
        async transferArtifact() { return {}; }
    });
    const endpoint = new McpEndpointWorker({
        gateway,
        instanceName: "main-pc",
        policy: { capabilities: ["read"], groups: ["artifact"] },
        worker: createWorker(false, true)
    });
    assert.deepEqual(endpoint.listTools().map((tool) => tool.name), ["artifact_read"]);
});

function createWorker(ready: boolean, hasSchema: boolean) {
    return {
        async appendMcpSessionClosed() {},
        async appendMcpSessionOpened() {},
        async appendMcpToolCalled() {},
        async callTool() { return {}; },
        hasToolSchemaCache() { return hasSchema; },
        listTools() { return [artifactRead]; },
        snapshot() { return { ready }; }
    };
}

function createGateway(overrides: Partial<McpInstanceGateway>): McpInstanceGateway {
    return {
        assertReady() {},
        async callTool() { return {}; },
        async createSshInstance(_source, input) { return { name: input.name }; },
        async listInstances() { return []; },
        listTools() { return [artifactRead]; },
        async readTodo() { return { items: [], revision: 0, summary: { completed: 0, total: 0 } }; },
        async startInstance(instance) { return { instance }; },
        async statusInstance(instance) { return { instance }; },
        async stopInstance(instance) { return { instance }; },
        async writeTodo() { return { items: [], revision: 0, summary: { completed: 0, total: 0 } }; },
        ...overrides
    };
}
