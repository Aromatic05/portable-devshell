import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue, ToolCallContext, ToolDefinition } from "@portable-devshell/shared";
import { McpContextRegistry, McpEndpointWorker, type McpInstanceGateway } from "@portable-devshell/mcp/testing";

const context = { principal: "local", requestId: "artifact-request" } as const;
const contextRegistry = new McpContextRegistry({ idFactory: () => "ctx-artifact-test" });
const activeContext = await contextRegistry.create({
    instance: "main-pc",
    principal: "local",
    workspace: "/workspace"
});
const withContext = <T extends Record<string, unknown>>(input: T): T & { ctxId: string } => ({
    ...input,
    ctxId: activeContext.ctxId
});

const artifactRead: ToolDefinition = {
    description: "Read an artifact payload.",
    group: "artifact",
    inputSchema: { type: "object" },
    name: "artifact_read",
    outputSchema: { type: "object" },
    requiredCapabilities: ["read"]
};

const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
);

test("artifact fixed MCP surface contains read and image primitives but no management operations", () => {
    const gateway = createGateway({
        async viewArtifactImage() {
            return {
                bytes: png.length,
                content: png.toString("base64"),
                encoding: "base64",
                mediaType: "image/png",
                name: "pixel.png",
                source: { instance: "main-pc", path: "./pixel.png", type: "file" }
            };
        }
    });
    const endpoint = new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        worker: createWorker(false, true)
    });
    const names = endpoint.listTools().map((tool) => tool.name);
    assert.equal(names.includes("artifact_read"), true);
    assert.equal(names.includes("artifact_viewImage"), true);
    assert.equal(names.includes("artifact_share"), false);
    assert.equal(names.includes("artifact_transfer"), false);
});

test("remote artifact path operations request an instance workspace attachment", async () => {
    const gateway = createGateway({
        async viewArtifactImage() {
            throw new Error("unexpected");
        }
    });
    const endpoint = new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        worker: createWorker(false, true)
    });

    await assert.rejects(
        endpoint.callTool(
            "artifact_viewImage",
            withContext({ instance: "remote-server", path: "./dist" }),
            context
        ),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "mcp.contextWorkspaceRequired");
            return true;
        }
    );
});

function createWorker(ready: boolean, hasSchema: boolean) {
    return {
        async auditToolCall<T extends JsonValue>(
            _toolName: string,
            _input: JsonValue,
            _context: ToolCallContext,
            operation: (callId: string) => Promise<T>
        ): Promise<T> { return await operation("call-test"); },
        async appendMcpSessionClosed() {},
        async appendMcpSessionOpened() {},
        async appendMcpToolCalled() {},
        async callTool() { return {}; },
        async readAlerts() { return { advice: [] }; },
        hasToolSchemaCache() { return hasSchema; },
        listTools() { return [artifactRead]; },
        snapshot() { return { ready }; }
    };
}

function createGateway(overrides: Partial<McpInstanceGateway>): McpInstanceGateway {
    return {
        ...overrides,
        async appendMcpToolCalled() {},
        assertReady() {},
        async auditToolCall<T extends JsonValue>(
            instance: string,
            toolName: string,
            input: JsonValue,
            context: ToolCallContext,
            operation: (callId: string) => Promise<T>,
            signal?: AbortSignal
        ): Promise<T> {
            if (overrides.auditToolCall !== undefined) {
                return await overrides.auditToolCall(instance, toolName, input, context, operation, signal);
            }
            return await operation("call-test");
        },
        async callTool() { return {}; },
        environment() { return undefined; },
        async listInstances() { return []; },
        listTools() { return [artifactRead]; },
        async prepareWorkspace(_instance, workspace) {
            return {
                projectMemoryAgentFile: `${workspace}/.devshell/AGENT.md`,
                projectMemoryDirectory: `${workspace}/.devshell`,
                projectMemoryPresent: true,
                temporaryDirectory: "/tmp/mcp-artifact",
                workspace
            };
        },
        async readAlerts() { return { advice: [] }; },
        async releaseAlerts(instance, workspace) {
            await overrides.releaseAlerts?.(instance, workspace);
        },
        async readTodo() { return { items: [], revision: 0, summary: { completed: 0, total: 0 } }; },
        async connectInstance(instance) { return { instance }; },
        async statusInstance(instance) { return { instance }; },
        async stopInstance(instance) { return { instance }; },
        async touchAlerts() {},
        async touchTemporaryDirectory() {},
        async writeTodo() { return { items: [], revision: 0, summary: { completed: 0, total: 0 } }; },
    };
}
