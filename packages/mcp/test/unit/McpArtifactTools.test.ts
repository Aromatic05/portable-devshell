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
        comment: [],
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

    for (const tool of endpoint.listTools()) {
        const schema = tool.inputSchema as { properties?: Record<string, unknown> };
        assert.equal(schema.properties?.instance, undefined, tool.name);
    }
    for (const name of ["artifact_viewImage", "artifact_share", "artifact_transfer"]) {
        const schema = endpoint.listTools().find((tool) => tool.name === name)?.inputSchema as {
            oneOf?: unknown;
            properties?: Record<string, unknown>;
            type?: string;
        };
        assert.equal(schema.oneOf, undefined, name);
        assert.equal(schema.type, "object", name);
        assert.notEqual(schema.properties, undefined, name);
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
        { data: png.toString("base64"), mimeType: "image/png", type: "image" }
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
                targetPath: "/srv/app",
                targetWorkspace: "/srv"
            }),
            context
        ),
        { transferId: "transfer-1" }
    );
    assert.deepEqual(calls, [
        { defaultInstance: "main-pc", input: { path: "./dist", workspace: "/workspace" }, kind: "share" },
        { defaultInstance: "main-pc", input: { path: "./pixel.png", workspace: "/workspace" }, kind: "viewImage" },
        {
            defaultInstance: "main-pc",
            input: {
                operation: "start",
                overwrite: false,
                sourcePath: "./dist",
                sourceWorkspace: "/workspace",
                targetInstance: "remote-server",
                targetPath: "/srv/app",
                targetWorkspace: "/srv"
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
    const names = endpoint.listTools().map((tool) => tool.name);
    assert.equal(names.includes("artifact_read"), true);
    assert.equal(names.includes("artifact_viewImage"), true);
    assert.equal(names.includes("artifact_share"), false);
    assert.equal(names.includes("artifact_transfer"), false);
});

test("remote artifact path operations request an instance workspace attachment", async () => {
    const gateway = createGateway({
        async shareArtifact() {
            return { shareId: "unexpected" };
        }
    });
    const endpoint = new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        policy: {
            capabilities: ["read", "write", "manage"],
            groups: ["artifact", "instance"]
        },
        worker: createWorker(false, true)
    });

    await assert.rejects(
        endpoint.callTool(
            "artifact_share",
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
        async createSshInstance(_source, input) { return { name: input.name }; },
        environment() { return undefined; },
        async listInstances() { return []; },
        listTools() { return [artifactRead]; },
        async prepareWorkspace(_instance, workspace) {
            return {
                projectMemoryAgentFile: `${workspace}/.devshell/AGENT.md`,
                projectMemoryDirectory: `${workspace}/.devshell`,
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
