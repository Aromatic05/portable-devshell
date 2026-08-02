import assert from "node:assert/strict";
import test from "node:test";

import type {
    ContextMessageReadResult,
    JsonValue,
    ToolCallContext,
    ToolDefinition,
} from "@portable-devshell/shared";

import { McpEndpointCatalog } from "../../src/endpoint/McpEndpointCatalog.ts";
import { McpEndpointDispatch } from "../../src/endpoint/McpEndpointDispatch.ts";

const bashTool: ToolDefinition = {
    description: "Run a command.",
    group: "bash",
    inputSchema: {
        additionalProperties: false,
        properties: { command: { type: "string" } },
        required: ["command"],
        type: "object",
    },
    name: "bash_run",
    outputSchema: {
        additionalProperties: false,
        properties: {
            exitCode: { type: "integer" },
            stderr: { type: "string" },
            stdout: { type: "string" },
        },
        required: ["exitCode", "stderr", "stdout"],
        type: "object",
    },
    requiredCapabilities: ["execute"],
};

test("queued Comments are not exposed as a standalone MCP tool", () => {
    const { catalog } = createHarness();
    assert.equal(
        catalog.listTools().some((tool) => tool.name === "context_message_read"),
        false,
    );
});

test("the next successful tool result carries queued Comments for its exact ctxId once", async () => {
    const pendingByCtx = new Map<string, ContextMessageReadResult>();
    const consumed: Array<{ ctxId: string; instance: string }> = [];
    const { dispatch } = createHarness({
        async consumeContextMessages(instance, ctxId) {
            consumed.push({ ctxId, instance });
            const result = pendingByCtx.get(ctxId) ?? { messages: [] };
            pendingByCtx.delete(ctxId);
            return result;
        },
    });

    const first = await createContext(dispatch, "ctx-a");
    const second = await createContext(dispatch, "ctx-b");
    pendingByCtx.set(first, {
        messages: [
            {
                createdAt: "2026-08-03T00:00:00.000Z",
                id: "message-a",
                text: "Review the failure before continuing",
            },
        ],
    });
    pendingByCtx.set(second, {
        messages: [
            {
                createdAt: "2026-08-03T00:00:01.000Z",
                id: "message-b",
                text: "This belongs only to context B",
            },
        ],
    });

    const firstResult = await dispatch.callTool(
        "bash_run",
        { command: "pwd", ctxId: first },
        { principal: "tester", requestId: "call-a-1" },
    );
    assert.deepEqual(firstResult, {
        comment: ["Review the failure before continuing"],
        exitCode: 0,
        stderr: "",
        stdout: "ok",
    });

    const repeated = await dispatch.callTool(
        "bash_run",
        { command: "pwd", ctxId: first },
        { principal: "tester", requestId: "call-a-2" },
    );
    assert.deepEqual(repeated, { exitCode: 0, stderr: "", stdout: "ok" });

    const secondResult = await dispatch.callTool(
        "bash_run",
        { command: "pwd", ctxId: second },
        { principal: "tester", requestId: "call-b-1" },
    );
    assert.deepEqual(secondResult, {
        comment: ["This belongs only to context B"],
        exitCode: 0,
        stderr: "",
        stdout: "ok",
    });
    assert.deepEqual(consumed, [
        { ctxId: first, instance: "alpha" },
        { ctxId: first, instance: "alpha" },
        { ctxId: second, instance: "alpha" },
    ]);
});

test("a failed tool call does not consume a queued Comment", async () => {
    let consumeCount = 0;
    const { dispatch, worker } = createHarness({
        async consumeContextMessages() {
            consumeCount += 1;
            return {
                messages: [
                    {
                        createdAt: "2026-08-03T00:00:00.000Z",
                        id: "message-a",
                        text: "Keep this pending",
                    },
                ],
            };
        },
    });
    const ctxId = await createContext(dispatch, "failed");
    worker.fail = true;

    await assert.rejects(
        dispatch.callTool(
            "bash_run",
            { command: "false", ctxId },
            { principal: "tester", requestId: "call-failed" },
        ),
        /worker failed/u,
    );
    assert.equal(consumeCount, 0);
});

async function createContext(
    dispatch: McpEndpointDispatch,
    requestId: string,
): Promise<string> {
    const result = (await dispatch.callTool(
        "environ_info",
        {},
        { principal: "tester", requestId },
    )) as { ctxId: string };
    return result.ctxId;
}

function createHarness(
    gatewayOverrides: {
        consumeContextMessages?(
            instance: string,
            ctxId: string,
        ): Promise<ContextMessageReadResult>;
    } = {},
) {
    const worker = {
        fail: false,
        async appendMcpToolCalled() {},
        async auditToolCall<T extends JsonValue>(
            _toolName: string,
            _input: JsonValue,
            _context: ToolCallContext,
            operation: () => Promise<T>,
        ): Promise<T> {
            return await operation();
        },
        async callTool(): Promise<JsonValue> {
            if (worker.fail) throw new Error("worker failed");
            return { exitCode: 0, stderr: "", stdout: "ok" };
        },
        handshake: {
            instance: "alpha",
            platform: { arch: "x86_64", os: "linux" },
            skillsDirectory: "/workspace/.devshell/skills",
            workspace: "/workspace",
        },
        listTools: () => [bashTool],
        snapshot: () => ({ ready: true }),
        workspacePath: "/workspace",
    };
    const gateway = {
        assertReady() {},
        async callTool(): Promise<JsonValue> {
            return { exitCode: 0, stderr: "", stdout: "remote" };
        },
        async createSshInstance(): Promise<JsonValue> {
            return {};
        },
        async listInstances(): Promise<JsonValue> {
            return [];
        },
        listTools: () => [bashTool],
        async readTodo(): Promise<JsonValue> {
            return { items: [], revision: 0 };
        },
        async startInstance(): Promise<JsonValue> {
            return {};
        },
        async statusInstance(): Promise<JsonValue> {
            return {};
        },
        async stopInstance(): Promise<JsonValue> {
            return {};
        },
        async writeTodo(): Promise<JsonValue> {
            return {};
        },
        ...gatewayOverrides,
    };
    const catalog = new McpEndpointCatalog({
        gateway: gateway as never,
        instanceName: "alpha",
        policy: { capabilities: ["execute"], groups: ["bash"] },
        worker,
    });
    return {
        catalog,
        dispatch: new McpEndpointDispatch({
            catalog,
            gateway: gateway as never,
            instanceName: "alpha",
            worker: worker as never,
        }),
        worker,
    };
}
