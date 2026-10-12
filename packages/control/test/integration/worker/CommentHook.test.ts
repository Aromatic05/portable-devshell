import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
    CommentExtension,
    createCommentAdvice,
    createCommentDelivery,
    createCommentTodoAccess,
    createCommentTodoInvalid,
    createCommentToolCallGate,
    type CommentPort,
} from "@portable-devshell/comment-extension";
import { asInstanceName, type JsonValue, type ToolCallContext, type ToolDefinition } from "@portable-devshell/shared";
import { CONTEXT_MESSAGE_PUSH_TOOL_BUDGET } from "@portable-devshell/shared/testing";

import { createToolCallScope } from "../../../../core/src/toolcall/execution/Context.ts";
import { ToolCallExecutionTarget } from "../../../../core/src/toolcall/execution/ExecutionTarget.ts";
import { ToolCallExtensionBinding } from "../../../src/extension/api/point/toolcall/index.ts";
import { TestMcpHost } from "../../../../mcp/test/ContextRuntime.ts";
import { modernRpcHeaders, modernRpcRequest } from "../../../../mcp/test/integration/ModernProtocol.ts";
import { requireTcpPort } from "../../../../../test/TestHttpSupport.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { databaseCapability } from "../../../../../extensions/comment/test/helpers/Database.ts";

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

test("Comment #stop/#resume/#push gate real MCP tools/call through ToolCall Hooks", async (t) => {
    const root = await createTestTempDirectory("comment-mcp-boundary");
    const workspace = join(root, "workspace");
    const comment = new CommentExtension({
        instances: {
            list: () => [
                {
                    appendEvent: async () => undefined,
                    messageDatabaseFile: join(
                        root,
                        "message.sqlite3",
                    ),
                    enabled: true,
                    key: instanceKey,
                    legacyReports: async () => [],
                    name: instanceName,
                },
            ],
            onChange: () => () => undefined,
        },
        preferencesFile: join(root, "message-preferences.json"),
        database: databaseCapability((name) =>
            name === "message-preferences"
                ? join(root, "message-preferences.sqlite3")
                : join(root, "message.sqlite3"),
        ),
    });
    const binding = new ToolCallExtensionBinding(
        commentReviewRegistrationHost(comment.comment),
    );
    let executions = 0;
    const target = new ToolCallExecutionTarget({
        assertReady() {},
        audit: {
            createScope(
                callId: string,
                toolName: string,
                input: JsonValue,
                context: ToolCallContext,
            ) {
                return createToolCallScope(callId, toolName, input, context);
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
        instanceName,
        log: { async append() {} },
        toolCallScheduler: {
            reserve() {
                return {
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
    const worker = createWorker(workspace);
    const host = new TestMcpHost({
        // Use one ToolCall runtime for the real Context bootstrap and Comment
        // review/rewrite gates. Overriding `tools` with a separate runtime
        // bypasses the Context installer and misroutes environ_info to bash.
        configureToolCalls(runtime) {
            const uninstall = binding.install(runtime.hooks);
            t.after(uninstall);
        },
        resolveTarget: () => target,
        instances: [
            {
                auth: { enabled: false, provider: "none" },
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
    const discover = await postJson(
        endpoint,
        modernRpcRequest("discover", "server/discover"),
        modernRpcHeaders("server/discover"),
    );
    assert.equal(discover.error, undefined, JSON.stringify(discover));
    const headers: Record<string, string> = {};
    const environmentParams = {
        arguments: { workspace },
        name: "environ_info",
    };
    const context = await postJson(
        endpoint,
        modernRpcRequest("environment", "tools/call", environmentParams),
        modernRpcHeaders("tools/call", environmentParams),
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

    const pendingReport = await comment.comment.pendingReport(
        instanceName,
        ctxId,
    );
    await comment.messageHistory.recordReport(instanceName, {
        callId: "push-report",
        ctxId,
        ...pendingReport,
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

function commentReviewRegistrationHost(comment: CommentPort) {
    const bindings: Record<string, unknown> = {
        "toolcall-gate": createCommentToolCallGate(comment),
        "todo-access": createCommentTodoAccess(comment),
        "comment-delivery": createCommentDelivery(comment),
        "tool-advice": createCommentAdvice(),
        "todo-invalid": createCommentTodoInvalid(comment),
    };
    const declarations = [
        {
            hook: "500-toolcall-gate",
            id: "toolcall-gate",
            pointId: "toolcall.review",
        },
        {
            hook: "500-todo-access",
            id: "todo-access",
            pointId: "toolcall.rewrite",
        },
        {
            hook: "501-todo-invalid",
            id: "todo-invalid",
            pointId: "toolcall.rewrite",
        },
        {
            hook: "502-tool-advice",
            id: "tool-advice",
            pointId: "toolcall.rewrite",
        },
        {
            hook: "510-comment-delivery",
            id: "comment-delivery",
            pointId: "toolcall.rewrite",
        },
    ];
    return {
        async acquireRegistration(pointId: string, id: string) {
            const binding = bindings[id];
            assert.notEqual(binding, undefined, `${pointId}:${id}`);
            return {
                extensionId: "comment",
                lease: { release() {} },
                registration: { binding },
            };
        },
        listDeclarations(pointId: string) {
            return declarations
                .filter((declaration) => declaration.pointId === pointId)
                .map(({ hook, id }) => ({
                    declaration: { hook, id },
                    id,
                }));
        },
    } as never;
}

function createWorker(workspace: string) {
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

async function queueComment(
    comment: CommentExtension,
    ctxId: string,
    text: string,
): Promise<void> {
    const module = comment.routes
        .instance(instanceName)
        .find((candidate) => candidate.name === "message");
    const queue = module?.operations.find(
        (operation) => operation.name === "queueContextMessage",
    );
    if (queue === undefined)
        throw new Error("message.queueContextMessage is unavailable");
    queueSequence += 1;
    await queue.handle(
        {
            id: `queue-${queueSequence}`,
            name: "queueContextMessage",
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
    const params = {
        arguments: { command: `printf ${label}`, ctxId },
        name: "bash_run",
    };
    return await postJson(
        endpoint,
        modernRpcRequest(`bash-${callSequence}`, "tools/call", params),
        { ...headers, ...modernRpcHeaders("tools/call", params) },
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
    body: unknown,
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
