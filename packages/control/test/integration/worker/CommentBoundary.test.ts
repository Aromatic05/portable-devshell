import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { CommentExtension } from "@portable-devshell/comment-extension";
import {
    McpHost,
    type McpInstanceGateway,
} from "@portable-devshell/mcp/testing";
import {
    CONTEXT_MESSAGE_PUSH_TOOL_BUDGET,
    asInstanceName,
    type JsonValue,
    type ToolCallContext,
    type ToolDefinition,
} from "@portable-devshell/shared";

import { createCommentReview } from "../../../../../extensions/comment/src/builtin/CommentReview.ts";
import { createToolCallScope } from "../../../../../packages/core/src/toolcall/Context.ts";
import { ToolCallExecution } from "../../../../../packages/core/src/toolcall/Execution.ts";
import { ToolCallExtensionBinding } from "../../../src/control/extension/toolcall/Binding.ts";
import { ToolCallCommentReview } from "../../../src/control/extension/toolcall/interface/Comment.ts";
import { requireTcpPort } from "../../../../../test/TestHttpSupport.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

const instanceName = asInstanceName("comment-boundary");
const bashTool: ToolDefinition = {
    requiredCapabilities: ["execute"],
    description: "Run a shell command.",
    group: "bash",
    inputSchema: {
        additionalProperties: false,
        properties: { command: { type: "string" } },
        required: ["command"],
        type: "object",
    },
    name: "bash_run",
    outputSchema: { type: "object" },
};

test("Comment #stop/#resume/#push gate real MCP tools/call through ToolCall Boundary", async (t) => {
    const root = await createTestTempDirectory("comment-mcp-boundary");
    const workspace = join(root, "workspace");
    const comment = new CommentExtension({
        instances: {
            list: () => [
                {
                    appendEvent: async () => undefined,
                    conversationDatabaseFile: join(
                        root,
                        "conversation.sqlite3",
                    ),
                    enabled: true,
                    key: instanceKey,
                    legacyReports: async () => [],
                    name: instanceName,
                },
            ],
            onChange: () => () => undefined,
        },
        preferencesFile: join(root, "conversation-preferences.json"),
    });
    const binding = new ToolCallExtensionBinding(
        commentReviewRegistrationHost(),
        new ToolCallCommentReview(comment.comment),
    );
    let executions = 0;
    const execution = new ToolCallExecution({
        approval: {
            async prepare() {
                return {};
            },
        },
        assertReady() {},
        audit: {
            createScope(
                toolName: string,
                input: JsonValue,
                context: ToolCallContext,
            ) {
                return createToolCallScope(toolName, input, context);
            },
            async requested() {},
            async queued() {},
            async denied() {},
            runningContext() {
                return {};
            },
            async running() {},
            async completed() {},
            async failed() {},
            async failActive() {},
            async nonRunning() {},
        },
        boundary: async (context) => await binding.acquire(context),
        instanceName,
        log: { async append() {} },
        toolCallScheduler: {
            reserve() {
                return {
                    markPendingApproval() {},
                    release() {},
                    async run<T>(operation: () => Promise<T>): Promise<T> {
                        return await operation();
                    },
                };
            },
        },
        toolInvoker: {
            async invoke() {
                executions += 1;
                return { exitCode: 0, stderr: "", stdout: "ok" };
            },
        },
    } as never);
    const worker = createWorker(execution, workspace);
    const gateway = createCommentGateway(comment, worker.handshake);
    const host = new McpHost({
        instances: [
            {
                auth: { enabled: false, provider: "none" },
                gateway,
                name: instanceName,
                worker: worker as never,
            },
        ],
        listenHost: "127.0.0.1",
        listenPort: 0,
    });
    t.after(async () => {
        await host.stop().catch(() => undefined);
        await comment.close().catch(() => undefined);
    });

    await host.start();
    const endpoint = `http://127.0.0.1:${requireTcpPort(host.server.address)}/${instanceName}/mcp`;
    const initialize = await postJson(endpoint, {
        id: "initialize",
        jsonrpc: "2.0",
        method: "initialize",
        params: {
            capabilities: {},
            clientInfo: { name: "comment-boundary-test", version: "1" },
            protocolVersion: "2025-06-18",
        },
    });
    assert.equal(initialize.error, undefined, JSON.stringify(initialize));
    const headers = {
        "mcp-protocol-version": String(
            initialize.result?.protocolVersion ?? "",
        ),
    };
    await postRaw(
        endpoint,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        headers,
    );
    const context = await postJson(
        endpoint,
        {
            id: "environment",
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
                arguments: { workspace },
                name: "environ_info",
            },
        },
        headers,
    );
    const ctxId = context.result?.structuredContent?.ctxId;
    assert.ok(typeof ctxId === "string", JSON.stringify(context));

    await queueComment(comment, ctxId, "#stop Stop before any more tools");
    const stopped = await callBash(endpoint, headers, ctxId, "stop");
    assert.match(JSON.stringify(stopped.error), /control\.modelStopped/u);
    assert.equal(executions, 0);

    await queueComment(comment, ctxId, "#resume Continue now");
    const resumed = await callBash(endpoint, headers, ctxId, "resume");
    assert.match(JSON.stringify(resumed.error), /control\.modelResumed/u);
    assert.equal(executions, 0);

    const allowed = await callBash(endpoint, headers, ctxId, "allowed");
    assert.equal(allowed.error, undefined, JSON.stringify(allowed));
    assert.equal(allowed.result?.isError, false, JSON.stringify(allowed));
    assert.equal(executions, 1);

    await queueComment(comment, ctxId, "#push Reply before continuing");
    const pushDelivered = await callBash(
        endpoint,
        headers,
        ctxId,
        "push-delivery",
    );
    assert.equal(pushDelivered.error, undefined, JSON.stringify(pushDelivered));
    assert.match(
        JSON.stringify(pushDelivered.result),
        /#push Reply before continuing/u,
    );
    assert.equal(executions, 2);

    for (let index = 0; index < 2; index += 1) {
        const withinBudget = await callBash(
            endpoint,
            headers,
            ctxId,
            `push-budget-${index}`,
        );
        assert.equal(
            withinBudget.error,
            undefined,
            JSON.stringify(withinBudget),
        );
    }
    await queueComment(comment, ctxId, "Also include the current blocker");
    const followUpDelivered = await callBash(
        endpoint,
        headers,
        ctxId,
        "push-follow-up-delivery",
    );
    assert.equal(
        followUpDelivered.error,
        undefined,
        JSON.stringify(followUpDelivered),
    );
    assert.match(
        JSON.stringify(followUpDelivered.result),
        /Also include the current blocker/u,
    );

    const exhausted = await callBash(
        endpoint,
        headers,
        ctxId,
        "push-exhausted",
    );
    assert.match(
        JSON.stringify(exhausted.error),
        /control\.modelReplyRequired/u,
    );
    assert.match(
        JSON.stringify(exhausted.error),
        /#push Reply before continuing/u,
    );
    assert.match(
        JSON.stringify(exhausted.error),
        /Also include the current blocker/u,
    );
    assert.equal(executions, 5);

    await comment.conversation.recordReport(instanceName, {
        callId: "push-report",
        ctxId,
        text: "Reported progress and blocker.",
    });
    const afterReport = await callBash(
        endpoint,
        headers,
        ctxId,
        "after-report",
    );
    assert.equal(afterReport.error, undefined, JSON.stringify(afterReport));
    assert.equal(executions, 6);
});

const instanceKey = {};

function commentReviewRegistrationHost() {
    const review = createCommentReview();
    return {
        async acquireRegistration(pointId: string, id: string) {
            assert.equal(pointId, "toolcall.review");
            assert.equal(id, "comment");
            return {
                extensionId: "comment",
                lease: { release() {} },
                registration: { binding: review },
            };
        },
        listDeclarations(pointId: string) {
            return pointId === "toolcall.review" ? [{ id: "comment" }] : [];
        },
    } as never;
}

function createWorker(execution: ToolCallExecution, workspace: string) {
    const handshake = {
        homeDirectory: "/home/comment-boundary",
        instance: instanceName,
        platform: {
            arch: "x86_64",
            distribution: {
                id: "test",
                name: "Test Linux",
                version: "1",
            },
            os: "linux",
            packageManager: "test",
            shell: { executable: "/bin/sh", kind: "sh", version: "1" },
        },
    };
    return {
        handshake,
        async appendMcpSessionClosed() {},
        async appendMcpSessionOpened() {},
        async appendMcpToolCalled() {},
        async callToolOperation<T extends JsonValue>(
            toolName: string,
            input: JsonValue,
            context: ToolCallContext,
            operation: (callId: string, input: JsonValue) => Promise<T>,
            signal?: AbortSignal,
            onFeedback?: (feedback: readonly string[]) => void,
            afterReview?: (callId: string) => Promise<void> | void,
        ): Promise<T> {
            return await execution.callOperation(
                toolName,
                input,
                context,
                operation,
                signal,
                onFeedback,
                afterReview,
            );
        },
        async callTool(
            toolName: string,
            input: JsonValue,
            context: ToolCallContext,
            signal?: AbortSignal,
            transformResult?: (
                result: JsonValue,
                callId: string,
            ) => Promise<JsonValue>,
            invocationInput?: (
                input: JsonValue,
            ) => Promise<JsonValue> | JsonValue,
            onProgress?: (progress: JsonValue) => void,
            recording: "caller" | "host" = "host",
            onFeedback?: (feedback: readonly string[]) => void,
            afterReview?: (callId: string) => Promise<void> | void,
        ): Promise<JsonValue> {
            return await execution.call(
                toolName,
                input,
                context,
                signal,
                transformResult,
                invocationInput,
                onProgress,
                recording,
                onFeedback,
                afterReview,
            );
        },
        hasToolSchemaCache() {
            return true;
        },
        listTools() {
            return [bashTool];
        },
        async prepareExtensionResource() {
            return {
                directory: join(workspace, ".devshell", "extensions", "skill"),
            };
        },
        async prepareWorkspace(inputWorkspace: string) {
            return {
                projectMemoryAgentFile: join(
                    inputWorkspace,
                    ".devshell",
                    "AGENT.md",
                ),
                projectMemoryDirectory: join(inputWorkspace, ".devshell"),
                projectMemoryPresent: false,
                temporaryDirectory: join(inputWorkspace, ".devshell", "tmp"),
                workspace: inputWorkspace,
            };
        },
        async readAlerts() {
            return { advice: [] };
        },
        snapshot() {
            return { ready: true };
        },
        async touchAlerts() {},
        async touchTemporaryDirectory() {},
    };
}

function createCommentGateway(
    comment: CommentExtension,
    handshake: ReturnType<typeof createWorker>["handshake"],
): McpInstanceGateway {
    return {
        async appendMcpToolCalled() {},
        assertReady() {},
        async callToolOperation() {
            throw new Error("unexpected routed ToolCall operation");
        },
        async callTool() {
            throw new Error("unexpected routed ToolCall");
        },
        async consumeContextMessages(_instance, ctxId, callId) {
            return await comment.comment.consumePending(
                instanceName,
                ctxId,
                callId,
            );
        },
        environment() {
            return handshake as never;
        },
        async listInstances() {
            return [];
        },
        modelCommands() {
            return [];
        },
        async readTodo() {
            return {};
        },
        async writeTodo() {
            return {};
        },
    } as never;
}

async function queueComment(
    comment: CommentExtension,
    ctxId: string,
    text: string,
): Promise<void> {
    const module = comment.routes
        .instance(instanceName)
        .find((candidate) => candidate.name === "contextMessage");
    const queue = module?.operations.find(
        (operation) => operation.name === "queue",
    );
    if (queue === undefined)
        throw new Error("contextMessage.queue is unavailable");
    queueSequence += 1;
    await queue.handle(
        {
            id: `queue-${queueSequence}`,
            name: "queue",
            payload: { ctxId, text },
        },
        undefined as never,
    );
}

let queueSequence = 0;
let callSequence = 0;

async function callBash(
    endpoint: string,
    headers: Record<string, string>,
    ctxId: string,
    label: string,
): Promise<TestRpcResponse> {
    callSequence += 1;
    return await postJson(
        endpoint,
        {
            id: `bash-${callSequence}`,
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
                arguments: { command: `printf ${label}`, ctxId },
                name: "bash_run",
            },
        },
        headers,
    );
}

interface TestRpcResponse {
    error?: {
        code?: number;
        data?: JsonValue;
        message?: string;
    };
    result?: {
        isError?: boolean;
        protocolVersion?: string;
        structuredContent?: Record<string, JsonValue>;
    };
}

async function postJson(
    url: string,
    body: JsonValue,
    extraHeaders: Record<string, string> = {},
): Promise<TestRpcResponse> {
    const response = await fetch(url, {
        body: JSON.stringify(body),
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...extraHeaders,
        },
        method: "POST",
    });
    const text = await response.text();
    assert.equal(response.ok, true, text);
    const data = text
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6));
    return JSON.parse(data.at(-1) ?? text) as TestRpcResponse;
}

async function postRaw(
    url: string,
    body: JsonValue,
    extraHeaders: Record<string, string>,
): Promise<void> {
    const response = await fetch(url, {
        body: JSON.stringify(body),
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...extraHeaders,
        },
        method: "POST",
    });
    assert.equal(response.status, 202, await response.text());
}
