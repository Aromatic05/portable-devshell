import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue, ToolCallContext } from "@portable-devshell/shared";
import {
    McpContextRegistry,
    McpEndpointWorker,
    type McpInstanceGateway,
} from "@portable-devshell/mcp/testing";

const context = { principal: "local", requestId: "artifact-request" } as const;
const contextRegistry = new McpContextRegistry({
    idFactory: () => "ctx-artifact-test",
});
const activeContext = await contextRegistry.create({
    instance: "main-pc",
    principal: "local",
    workspace: "/workspace",
});
const withContext = <T extends Record<string, unknown>>(
    input: T,
): T & { ctxId: string } => ({
    ...input,
    ctxId: activeContext.ctxId,
});

const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
);

test("artifact fixed MCP surface contains image primitive but no read or management operations", () => {
    const gateway = createGateway({
        async viewArtifactImage() {
            const blake3 = "b".repeat(64);
            return {
                blake3,
                bytes: png.length,
                content: png.toString("base64"),
                encoding: "base64",
                imageRef: `${blake3}.png`,
                mediaType: "image/png",
                name: "pixel.png",
                source: {
                    instance: "main-pc",
                    path: "./pixel.png",
                    type: "file",
                },
            };
        },
    });
    const endpoint = new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        worker: createWorker(false, true),
    });
    const names = endpoint.listTools().map((tool) => tool.name);
    assert.equal(names.includes("artifact_read"), false);
    assert.equal(names.includes("artifact_viewImage"), true);
    assert.equal(names.includes("artifact_share"), false);
    assert.equal(names.includes("artifact_transfer"), false);
});

test("remote artifact path operations request an instance workspace attachment", async () => {
    const gateway = createGateway({
        async viewArtifactImage() {
            throw new Error("unexpected");
        },
    });
    const endpoint = new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        worker: createWorker(false, true),
    });

    await assert.rejects(
        endpoint.callTool(
            "artifact_viewImage",
            withContext({ instance: "remote-server", path: "./dist" }),
            context,
        ),
        (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                "mcp.contextWorkspaceRequired",
            );
            return true;
        },
    );
});

function createWorker(ready: boolean, hasSchema: boolean) {
    return {
        async callToolOperation<T extends JsonValue>(
            _toolName: string,
            input: JsonValue,
            _context: ToolCallContext,
            operation: (callId: string, input: JsonValue) => Promise<T>,
        ): Promise<T> {
            return await operation("call-test", input);
        },
        async appendMcpSessionClosed() {},
        async appendMcpSessionOpened() {},
        async appendMcpToolCalled() {},
        async callTool() {
            return {};
        },
        async readAlerts() {
            return { advice: [] };
        },
        hasToolSchemaCache() {
            return hasSchema;
        },
        listTools() {
            return [];
        },
        snapshot() {
            return { ready };
        },
    };
}

function createGateway(
    overrides: Partial<McpInstanceGateway>,
): McpInstanceGateway {
    return {
        ...overrides,
        async appendMcpToolCalled() {},
        assertReady() {},
        async callToolOperation<T extends JsonValue>(
            instance: string,
            toolName: string,
            input: JsonValue,
            context: ToolCallContext,
            operation: (callId: string, input: JsonValue) => Promise<T>,
            signal?: AbortSignal,
        ): Promise<T> {
            if (overrides.callToolOperation !== undefined) {
                return await overrides.callToolOperation(
                    instance,
                    toolName,
                    input,
                    context,
                    operation,
                    signal,
                );
            }
            return await operation("call-test", input);
        },
        async callTool() {
            return {};
        },
        environment() {
            return undefined;
        },
        async listInstances() {
            return [];
        },
        listTools() {
            return [];
        },
        async prepareWorkspace(_instance, workspace) {
            return {
                projectMemoryAgentFile: `${workspace}/.devshell/AGENT.md`,
                projectMemoryDirectory: `${workspace}/.devshell`,
                projectMemoryPresent: true,
                temporaryDirectory: "/tmp/mcp-artifact",
                workspace,
            };
        },
        async readAlerts() {
            return { advice: [] };
        },
        async releaseAlerts(instance, workspace) {
            await overrides.releaseAlerts?.(instance, workspace);
        },
        async readTodo() {
            return {
                items: [],
                revision: 0,
                summary: { completed: 0, total: 0 },
            };
        },
        async connectInstance(instance) {
            return { instance };
        },
        async statusInstance(instance) {
            return { instance };
        },
        async stopInstance(instance) {
            return { instance };
        },
        async touchAlerts() {},
        async touchTemporaryDirectory() {},
        async writeTodo() {
            return {
                items: [],
                revision: 0,
                summary: { completed: 0, total: 0 },
            };
        },
    };
}

test("native control result uses the Boundary-returned structured content", async () => {
    const gateway = createGateway({
        async viewArtifactImage() {
            const blake3 = "b".repeat(64);
            return {
                blake3,
                bytes: png.length,
                content: png.toString("base64"),
                encoding: "base64",
                imageRef: `${blake3}.png`,
                mediaType: "image/png",
                name: "inner-secret.png",
                source: {
                    instance: "main-pc",
                    path: "./inner-secret.png",
                    type: "file",
                },
            };
        },
    });
    const worker = createWorker(false, true);
    worker.callToolOperation = async <T extends JsonValue>(
        _toolName: string,
        input: JsonValue,
        _context: ToolCallContext,
        operation: (callId: string, input: JsonValue) => Promise<T>,
    ): Promise<T> => {
        const result = await operation("call-boundary", input);
        return {
            ...(result as Record<string, JsonValue>),
            name: "outer-masked.png",
        } as T;
    };
    const endpoint = new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        worker,
    });

    const result = await endpoint.callTool(
        "artifact_viewImage",
        withContext({ path: "./inner-secret.png" }),
        context,
    );

    assert.deepEqual(
        (result as { structuredContent?: Record<string, JsonValue> })
            .structuredContent?.name,
        "outer-masked.png",
    );
});
