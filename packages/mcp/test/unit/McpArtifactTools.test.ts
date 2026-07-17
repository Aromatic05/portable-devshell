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

test("artifact endpoint exposes worker read plus control share and transfer while worker is stopped", async () => {
    const calls: Array<{ kind: string; defaultInstance: string; input: JsonValue }> = [];
    const gateway = createGateway({
        async viewArtifactImage(defaultInstance, input) {
            calls.push({ defaultInstance, input: input as unknown as JsonValue, kind: "viewImage" });
            return {
                bytes: png.length,
                content: png.toString("base64"),
                encoding: "base64",
                mediaType: "image/png",
                name: "pixel.png",
                source: {
                    instance: defaultInstance,
                    path: "./pixel.png",
                    type: "file"
                }
            };
        },
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
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        policy: { capabilities: ["read", "write"], groups: ["artifact"] },
        worker: createWorker(false, true)
    });

    assert.deepEqual(endpoint.listTools().map((tool) => tool.name), [
        "environ_info",
        "artifact_read",
        "artifact_viewImage",
        "artifact_share",
        "artifact_transfer"
    ]);
    for (const tool of endpoint.listTools()) {
        const schema = tool.inputSchema as { properties?: Record<string, unknown> };
        assert.equal(schema.properties?.instance, undefined, tool.name);
    }
    assert.deepEqual(await endpoint.callTool("artifact_share", withContext({ path: "./dist" }), context), {
        shareId: "share-1"
    });
    const image = await endpoint.callTool(
        "artifact_viewImage",
        withContext({ path: "./pixel.png" }),
        context
    ) as unknown as {
        content: Array<{ data?: string; mimeType?: string; text?: string; type: string }>;
        structuredContent: JsonValue;
    };
    assert.deepEqual(image.content, [
        { data: png.toString("base64"), mimeType: "image/png", type: "image" },
        { text: "pixel.png (image/png, 68 bytes)", type: "text" }
    ]);
    assert.deepEqual(image.structuredContent, {
        bytes: png.length,
        mediaType: "image/png",
        name: "pixel.png",
        source: {
            instance: "main-pc",
            path: "./pixel.png",
            type: "file"
        }
    });
    assert.deepEqual(
        await endpoint.callTool(
            "artifact_transfer",
            withContext({
                operation: "start",
                sourcePath: "./dist",
                targetInstance: "remote-server",
                targetPath: "/srv/app"
            }),
            context
        ),
        { transferId: "transfer-1" }
    );
    assert.deepEqual(calls, [
        { defaultInstance: "main-pc", input: { path: "./dist" }, kind: "share" },
        { defaultInstance: "main-pc", input: { path: "./pixel.png" }, kind: "viewImage" },
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

test("artifact control tools apply read-only and mutating capability requirements independently", () => {
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
        },
        async shareArtifact() { return {}; },
        async transferArtifact() { return {}; }
    });
    const endpoint = new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        policy: { capabilities: ["read"], groups: ["artifact"] },
        worker: createWorker(false, true)
    });
    assert.deepEqual(endpoint.listTools().map((tool) => tool.name), [
        "environ_info",
        "artifact_read",
        "artifact_viewImage"
    ]);
});

function createWorker(ready: boolean, hasSchema: boolean) {
    return {
        async auditToolCall<T extends JsonValue>(
            _toolName: string,
            _input: JsonValue,
            _context: ToolCallContext,
            operation: () => Promise<T>
        ): Promise<T> { return await operation(); },
        async appendMcpSessionClosed() {},
        async appendMcpSessionOpened() {},
        async appendMcpToolCalled() {},
        async callTool() { return {}; },
        workspacePath: "/workspace",
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
