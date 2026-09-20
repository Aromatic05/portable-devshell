import assert from "node:assert/strict";
import test from "node:test";
import { toControlErrorBody } from "@portable-devshell/shared";

import {
    InstanceRegistry,
    McpInstanceGatewayControl,
    createDefaultControlConfig,
} from "../../../../src/testing.ts";

function emptyComment() {
    return {
        async consumePending(
            _instance: string,
            _ctxId: string,
            callId: string,
        ) {
            return { callId, messages: [] };
        },
        async failPending() {
            return [];
        },
        async listConversation() {
            return [];
        },
        async pendingReplyCommentId() {
            return undefined;
        },
        async pendingPushMessage() {
            return undefined;
        },
        async recordReport() {},
    };
}

function emptyConversation() {
    return {
        async list() {
            return [];
        },
        async recordReport() {},
    };
}

function createGateway(ready: boolean): McpInstanceGatewayControl {
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpEnabled: true,
            mcpPath: "/remote-server/mcp",
            modelExtensions: ["instance"],
            name: "remote-server",
            worker: {
                snapshot() {
                    return { ready };
                },
            },
        } as never,
    ]);

    return new McpInstanceGatewayControl({
        comment: emptyComment(),
        conversation: emptyConversation(),
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry,
    });
}

function createTodoReportHarness() {
    let now = Date.parse("2026-09-14T00:00:00.000Z");
    let callSequence = 0;
    let failNext = false;
    let pendingReplyCommentId: string | undefined;
    let pendingPushMessage: string | undefined;
    const entries: Array<Record<string, unknown>> = [];
    const reports: string[] = [];
    const comment = {
        async consumePending(
            _instance: string,
            _ctxId: string,
            callId: string,
        ) {
            return { callId, messages: [] };
        },
        async failPending() {
            return [];
        },
        async listConversation(
            _instance: string,
            input: { ctxId?: string; limit?: number } = {},
        ) {
            const filtered = entries.filter(
                (entry) =>
                    input.ctxId === undefined || entry.ctxId === input.ctxId,
            );
            return (
                input.limit === undefined
                    ? filtered
                    : filtered.slice(-input.limit)
            ) as never;
        },
        async pendingReplyCommentId() {
            return pendingReplyCommentId;
        },
        async pendingPushMessage() {
            return pendingPushMessage;
        },
        async recordReport(
            _instance: string,
            input: {
                callId: string;
                ctxId: string;
                replyCommentId?: string;
                text: string;
            },
        ) {
            if (failNext) {
                failNext = false;
                throw new Error("report failed");
            }
            reports.push(input.text);
            entries.push({
                callId: input.callId,
                createdAt: new Date(now).toISOString(),
                ctxId: input.ctxId,
                id: input.callId,
                kind: "report",
                text: input.text,
            });
            if (
                input.replyCommentId !== undefined &&
                input.replyCommentId === pendingReplyCommentId
            ) {
                pendingReplyCommentId = undefined;
            }
            pendingPushMessage = undefined;
        },
    };
    const conversation = {
        list: comment.listConversation,
        recordReport: comment.recordReport,
    };
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpEnabled: true,
            mcpPath: "/local/mcp",
            modelExtensions: [],
            name: "local",
        } as never,
    ]);
    const gateway = new McpInstanceGatewayControl({
        comment,
        conversation,
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry,
        now: () => now,
    });
    const context = {
        ctxId: "ctx-report-policy",
        source: "mcp" as const,
        workspace: "/workspace",
    };

    return {
        advance(milliseconds: number) {
            now += milliseconds;
        },
        context,
        deliverComment(id: string, text: string) {
            const timestamp = new Date(now).toISOString();
            entries.push({
                callId: `delivery-${id}`,
                createdAt: timestamp,
                ctxId: context.ctxId,
                deliveredAt: timestamp,
                id,
                kind: "comment",
                status: "delivered",
                text,
            });
            pendingReplyCommentId = id;
        },
        failNextReport() {
            failNext = true;
        },
        push(message: string) {
            pendingPushMessage = message;
        },
        gateway,
        async report(message: string) {
            callSequence += 1;
            await gateway.reportTodo(
                "local",
                message,
                `report-${callSequence}`,
                context,
            );
        },
        reports,
    };
}

async function assertTodoUseOtherTools(
    operation: Promise<unknown>,
): Promise<void> {
    await assert.rejects(operation, (error: unknown) => {
        const body = toControlErrorBody(error);
        assert.equal(body?.code, "todo.invalid");
        assert.equal(body?.retryable, false);
        assert.equal(
            body?.message,
            "You have performed too many useless operations. Use other tools.",
        );
        assert.equal(
            typeof body?.details === "object" &&
                body.details !== null &&
                !Array.isArray(body.details)
                ? body.details.action
                : undefined,
            "use_other_tools",
        );
        return true;
    });
}

test("cross-instance readiness check reports core.instanceNotReady before schema lookup", () => {
    const gateway = createGateway(false);

    assert.throws(
        () => gateway.assertReady("remote-server"),
        (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                "core.instanceNotReady",
            );
            assert.deepEqual((error as { details?: unknown }).details, {
                instance: "remote-server",
            });
            return true;
        },
    );
});

test("cross-instance readiness check accepts a ready target", () => {
    const gateway = createGateway(true);

    assert.doesNotThrow(() => gateway.assertReady("remote-server"));
});

test("cross-instance audit is recorded by the target worker", async () => {
    const calls: Array<{ context: unknown; input: unknown; toolName: string }> =
        [];
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpEnabled: true,
            mcpPath: "/remote-server/mcp",
            modelExtensions: [],
            name: "remote-server",
            worker: {
                async callToolOperation(
                    toolName: string,
                    input: unknown,
                    context: unknown,
                    operation: (
                        callId: string,
                        input: unknown,
                    ) => Promise<unknown>,
                ) {
                    calls.push({ context, input, toolName });
                    return await operation("remote-call", input);
                },
            },
        } as never,
    ]);
    const gateway = new McpInstanceGatewayControl({
        comment: emptyComment(),
        conversation: emptyConversation(),
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry,
    });

    const result = await gateway.callToolOperation(
        "remote-server",
        "artifact_viewImage",
        { path: "./preview.png" },
        { ctxId: "ctx-remote", source: "mcp", workspace: "/projects/remote" },
        async (callId) => ({ callId }),
    );

    assert.deepEqual(result, { callId: "remote-call" });
    assert.deepEqual(calls, [
        {
            context: {
                ctxId: "ctx-remote",
                source: "mcp",
                workspace: "/projects/remote",
            },
            input: { path: "./preview.png" },
            toolName: "artifact_viewImage",
        },
    ]);
});

test("todo_report autonomous updates use a two-token bucket with fractional refill", async () => {
    const harness = createTodoReportHarness();

    await harness.report("first");
    await harness.report("second");
    await assertTodoUseOtherTools(harness.report("third"));
    harness.advance(15_000);
    await assertTodoUseOtherTools(harness.report("third"));
    harness.advance(15_000);
    await harness.report("third");
    harness.advance(60_000);
    await harness.report("fourth");
    await harness.report("fifth");
    await assertTodoUseOtherTools(harness.report("sixth"));

    assert.deepEqual(harness.reports, [
        "first",
        "second",
        "third",
        "fourth",
        "fifth",
    ]);
});

test("todo_report rejects an unchanged autonomous report without spending a token", async () => {
    const harness = createTodoReportHarness();

    await harness.report("same");
    await assert.rejects(harness.report("same"), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "todo.invalid");
        assert.equal(
            (error as { details?: { reason?: string } }).details?.reason,
            "duplicate",
        );
        return true;
    });
    await harness.report("second");
    await assertTodoUseOtherTools(harness.report("third"));
});

test("four todo.invalid failures within two minutes disable Todo for five minutes", async () => {
    const harness = createTodoReportHarness();

    await harness.report("same");
    for (let index = 0; index < 4; index += 1) {
        await assert.rejects(
            harness.report("same"),
            (error: unknown) =>
                toControlErrorBody(error)?.code === "todo.invalid",
        );
    }

    await assertTodoUseOtherTools(
        harness.gateway.beforeTodoToolCall(
            "local",
            "todo_read",
            harness.context,
        ),
    );
    harness.advance(299_999);
    await assertTodoUseOtherTools(
        harness.gateway.beforeTodoToolCall(
            "local",
            "todo_report",
            harness.context,
        ),
    );
    harness.advance(1);
    await harness.gateway.beforeTodoToolCall(
        "local",
        "todo_report",
        harness.context,
    );
});

test("todo.invalid failures outside the two-minute window do not accumulate", async () => {
    const harness = createTodoReportHarness();

    await harness.report("same");
    for (let index = 0; index < 3; index += 1) {
        await assert.rejects(
            harness.report("same"),
            (error: unknown) =>
                toControlErrorBody(error)?.code === "todo.invalid",
        );
    }
    harness.advance(120_000);
    await assert.rejects(
        harness.report("same"),
        (error: unknown) => toControlErrorBody(error)?.code === "todo.invalid",
    );

    await harness.report("new information");
});

test("todo_report serializes concurrent autonomous bursts through the same bucket", async () => {
    const harness = createTodoReportHarness();

    const results = await Promise.allSettled([
        harness.report("parallel one"),
        harness.report("parallel two"),
        harness.report("parallel three"),
    ]);

    assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        2,
    );
    assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
    );
    assert.equal(harness.reports.length, 2);
});

test("todo_read and todo_write share a bucket that is independent from todo_report", async () => {
    const harness = createTodoReportHarness();

    await harness.gateway.beforeTodoToolCall(
        "local",
        "todo_read",
        harness.context,
    );
    await harness.gateway.beforeTodoToolCall(
        "local",
        "todo_write",
        harness.context,
    );
    await assertTodoUseOtherTools(
        harness.gateway.beforeTodoToolCall(
            "local",
            "todo_read",
            harness.context,
        ),
    );

    await harness.report("report one");
    await harness.report("report two");
    await assertTodoUseOtherTools(harness.report("report three"));
    await assertTodoUseOtherTools(
        harness.gateway.beforeTodoToolCall(
            "local",
            "todo_read",
            harness.context,
        ),
    );

    harness.advance(30_000);
    await harness.gateway.beforeTodoToolCall(
        "local",
        "todo_write",
        harness.context,
    );
    await harness.report("report three");
});

test("todo_read and todo_write serialize concurrent bursts through their shared bucket", async () => {
    const harness = createTodoReportHarness();

    const results = await Promise.allSettled([
        harness.gateway.beforeTodoToolCall(
            "local",
            "todo_read",
            harness.context,
        ),
        harness.gateway.beforeTodoToolCall(
            "local",
            "todo_write",
            harness.context,
        ),
        harness.gateway.beforeTodoToolCall(
            "local",
            "todo_read",
            harness.context,
        ),
    ]);

    assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        2,
    );
    assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
    );
});

test("failed reports neither spend a token nor satisfy a Comment obligation", async () => {
    const harness = createTodoReportHarness();
    harness.failNextReport();
    await assert.rejects(harness.report("first"), /report failed/u);
    await harness.report("first");
    await harness.report("second");
    await assertTodoUseOtherTools(harness.report("third"));

    harness.deliverComment(
        "comment-failure",
        "Reply even if persistence fails",
    );
    harness.failNextReport();
    await assert.rejects(harness.report("reply"), /report failed/u);
    await harness.report("reply");
    await assertTodoUseOtherTools(harness.report("autonomous after reply"));
});

test("a required #push report bypasses the autonomous report bucket and clears only after success", async () => {
    const harness = createTodoReportHarness();
    await harness.report("autonomous one");
    await harness.report("autonomous two");
    harness.push("#push report progress");

    harness.failNextReport();
    await assert.rejects(harness.report("required reply"), /report failed/u);
    await harness.report("required reply");
    await assertTodoUseOtherTools(harness.report("autonomous after push"));
});

test("closing an MCP tool session releases worker-owned session state", async () => {
    const released: string[] = [];
    const registry = new InstanceRegistry(
        ["local-one", "remote-two"].map((name) => ({
            enabled: true,
            mcpEnabled: true,
            mcpPath: `/${name}/mcp`,
            modelExtensions: [],
            name,
            worker: {
                async releaseToolSession(sessionId: string) {
                    released.push(`${name}:${sessionId}`);
                },
            },
        })) as never,
    );
    const gateway = new McpInstanceGatewayControl({
        comment: emptyComment(),
        conversation: emptyConversation(),
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry,
    });

    await gateway.closeToolSession("session-shared");

    assert.deepEqual(released.sort(), [
        "local-one:session-shared",
        "remote-two:session-shared",
    ]);
});

test("MCP instance lifecycle responses preserve active Todo summaries", async () => {
    const activeTodos = [
        {
            completed: 1,
            currentItem: "Verify release lifecycle",
            revision: 3,
            status: "in_progress" as const,
            taskId: "release-review",
            title: "Release review",
            total: 2,
        },
    ];
    const snapshot = {
        connectionState: "disconnected",
        daemonState: "stopped",
        lastSeq: 4,
        name: "remote-server",
        ready: false,
        status: "stopped",
    };
    let currentSnapshot = snapshot;
    let startCalls = 0;
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpEnabled: true,
            mcpPath: "/remote-server/mcp",
            modelExtensions: ["instance"],
            name: "remote-server",
            todo: { summaries: () => activeTodos },
            worker: {
                managementMode: "controllerManaged",
                snapshot() {
                    return currentSnapshot;
                },
                async start() {
                    startCalls += 1;
                    currentSnapshot = {
                        ...snapshot,
                        daemonState: "running",
                        ready: true,
                        status: "ready",
                    };
                    return currentSnapshot;
                },
                async stop() {
                    currentSnapshot = snapshot;
                    return currentSnapshot;
                },
            },
        } as never,
    ]);
    const gateway = new McpInstanceGatewayControl({
        comment: emptyComment(),
        conversation: emptyConversation(),
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry,
    });

    assert.deepEqual(
        (
            (await gateway.connectInstance("remote-server", "ctx-one")) as {
                activeTodos?: unknown;
            }
        ).activeTodos,
        activeTodos,
    );
    await gateway.connectInstance("remote-server", "ctx-one");
    assert.equal(startCalls, 1);
    assert.deepEqual(
        (
            (await gateway.stopInstance("remote-server")) as {
                activeTodos?: unknown;
            }
        ).activeTodos,
        activeTodos,
    );
});

test("MCP instance connect lifecycle uses Context references without adopting an already-ready worker", async () => {
    let ready = false;
    let startCalls = 0;
    let stopCalls = 0;
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpEnabled: true,
            mcpPath: "/managed/mcp",
            modelExtensions: ["instance"],
            name: "managed",
            todo: { summaries: () => [] },
            worker: {
                managementMode: "controllerManaged",
                snapshot: () => ({ ready }),
                async start() {
                    startCalls += 1;
                    ready = true;
                    return { ready: true };
                },
                async stop() {
                    stopCalls += 1;
                    ready = false;
                    return { ready: false };
                },
            },
        } as never,
        {
            enabled: true,
            mcpEnabled: true,
            mcpPath: "/external/mcp",
            modelExtensions: ["instance"],
            name: "external",
            todo: { summaries: () => [] },
            worker: {
                managementMode: "controllerManaged",
                snapshot: () => ({ ready: true }),
                async stop() {
                    stopCalls += 100;
                    return { ready: false };
                },
            },
        } as never,
    ]);
    const gateway = new McpInstanceGatewayControl({
        comment: emptyComment(),
        conversation: emptyConversation(),
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry,
    });

    await gateway.connectInstance("managed", "ctx-a");
    await gateway.connectInstance("managed", "ctx-a");
    await gateway.connectInstance("managed", "ctx-b");
    assert.equal(startCalls, 1);

    await gateway.releaseInstanceReference("managed", "ctx-a");
    assert.equal(stopCalls, 0);
    await gateway.releaseInstanceReference("managed", "ctx-b");
    assert.equal(stopCalls, 1);

    await gateway.connectInstance("external", "ctx-external");
    await gateway.releaseInstanceReference("external", "ctx-external");
    await registry.stopOwned();
    assert.equal(stopCalls, 1);
});
