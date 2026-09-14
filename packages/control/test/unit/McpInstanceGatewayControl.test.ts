import assert from "node:assert/strict";
import test from "node:test";

import {
    InstanceRegistry,
    McpInstanceGatewayControl,
    createDefaultControlConfig
} from "../../src/testing.ts";

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
                }
            }
        } as never
    ]);

    return new McpInstanceGatewayControl({
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry
    });
}

function createTodoReportHarness() {
    let now = Date.parse("2026-09-14T00:00:00.000Z");
    let callSequence = 0;
    let failNext = false;
    const entries: Array<Record<string, unknown>> = [];
    const reports: string[] = [];
    const registry = new InstanceRegistry([{
        conversation: {
            close() {},
            async list(input: { ctxId?: string; limit?: number } = {}) {
                const filtered = entries.filter((entry) => input.ctxId === undefined || entry.ctxId === input.ctxId);
                return (input.limit === undefined ? filtered : filtered.slice(-input.limit)) as never;
            },
            async recordReport(input: { callId: string; ctxId: string; text: string }) {
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
            },
        },
        enabled: true,
        mcpEnabled: true,
        mcpPath: "/local/mcp",
        modelExtensions: [],
        name: "local",
    } as never]);
    const gateway = new McpInstanceGatewayControl({
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry,
        now: () => now,
    });
    const context = { ctxId: "ctx-report-policy", source: "mcp" as const, workspace: "/workspace" };

    return {
        advance(milliseconds: number) {
            now += milliseconds;
        },
        context,
        queueComment(id: string, text: string) {
            const timestamp = new Date(now).toISOString();
            entries.push({
                createdAt: timestamp,
                ctxId: context.ctxId,
                id,
                kind: "comment",
                status: "sent",
                text,
            });
        },
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
        },
        failNextReport() {
            failNext = true;
        },
        gateway,
        async report(message: string) {
            callSequence += 1;
            await gateway.reportTodo("local", message, `report-${callSequence}`, context);
        },
        reports,
    };
}

async function assertRateLimited(operation: Promise<unknown>, retryAfterMs: number): Promise<void> {
    await assert.rejects(operation, (error: unknown) => {
        assert.equal((error as { code?: string }).code, "todo.invalid");
        assert.equal((error as { details?: { retryAfterMs?: number } }).details?.retryAfterMs, retryAfterMs);
        return true;
    });
}

test("cross-instance readiness check reports core.instanceNotReady before schema lookup", () => {
    const gateway = createGateway(false);

    assert.throws(
        () => gateway.assertReady("remote-server"),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "core.instanceNotReady");
            assert.deepEqual((error as { details?: unknown }).details, {
                instance: "remote-server"
            });
            return true;
        }
    );
});

test("cross-instance readiness check accepts a ready target", () => {
    const gateway = createGateway(true);

    assert.doesNotThrow(() => gateway.assertReady("remote-server"));
});

test("cross-instance audit is recorded by the target worker", async () => {
    const calls: Array<{ context: unknown; input: unknown; toolName: string }> = [];
    const registry = new InstanceRegistry([{
        enabled: true,
        mcpEnabled: true,
        mcpPath: "/remote-server/mcp",
        modelExtensions: [],
        name: "remote-server",
        worker: {
            async auditToolCall(toolName: string, input: unknown, context: unknown, operation: (callId: string) => Promise<unknown>) {
                calls.push({ context, input, toolName });
                return await operation("remote-call");
            }
        }
    } as never]);
    const gateway = new McpInstanceGatewayControl({
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry
    });

    const result = await gateway.auditToolCall(
        "remote-server",
        "artifact_viewImage",
        { path: "./preview.png" },
        { ctxId: "ctx-remote", source: "mcp", workspace: "/projects/remote" },
        async (callId) => ({ callId })
    );

    assert.deepEqual(result, { callId: "remote-call" });
    assert.deepEqual(calls, [{
        context: { ctxId: "ctx-remote", source: "mcp", workspace: "/projects/remote" },
        input: { path: "./preview.png" },
        toolName: "artifact_viewImage"
    }]);
});

test("todo_report autonomous updates use a two-token bucket with fractional refill", async () => {
    const harness = createTodoReportHarness();

    await harness.report("first");
    await harness.report("second");
    await assertRateLimited(harness.report("third"), 30_000);
    harness.advance(15_000);
    await assertRateLimited(harness.report("third"), 15_000);
    harness.advance(15_000);
    await harness.report("third");
    harness.advance(60_000);
    await harness.report("fourth");
    await harness.report("fifth");
    await assertRateLimited(harness.report("sixth"), 30_000);

    assert.deepEqual(harness.reports, ["first", "second", "third", "fourth", "fifth"]);
});

test("todo_report rejects an unchanged autonomous report without spending a token", async () => {
    const harness = createTodoReportHarness();

    await harness.report("same");
    await assert.rejects(harness.report("same"), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "todo.invalid");
        assert.equal((error as { details?: { reason?: string } }).details?.reason, "duplicate");
        return true;
    });
    await harness.report("second");
    await assertRateLimited(harness.report("third"), 30_000);
});

test("todo_report serializes concurrent autonomous bursts through the same bucket", async () => {
    const harness = createTodoReportHarness();

    const results = await Promise.allSettled([
        harness.report("parallel one"),
        harness.report("parallel two"),
        harness.report("parallel three"),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(harness.reports.length, 2);
});

test("a normal Comment never limits tools and its reply bypasses the autonomous bucket", async () => {
    const harness = createTodoReportHarness();
    await harness.report("autonomous one");
    await harness.report("autonomous two");
    harness.deliverComment("comment-1", "Please answer this normally");
    for (let index = 0; index < 10; index += 1) {
        await harness.gateway.beforeModelToolCall("local", "file_read", harness.context);
    }
    await harness.report("reply to comment");
    await harness.gateway.beforeModelToolCall("local", "file_read", harness.context);
    await assertRateLimited(harness.report("autonomous exhausted"), 30_000);
    harness.advance(30_000);
    await harness.report("autonomous after refill");
});

test("a #push Comment gets five ordinary calls then requires todo_report", async () => {
    const harness = createTodoReportHarness();
    harness.deliverComment("comment-push", "#push Please answer this first");
    for (let index = 0; index < 5; index += 1) {
        await harness.gateway.beforeModelToolCall("local", "file_read", harness.context);
    }
    await assert.rejects(
        harness.gateway.beforeModelToolCall("local", "file_read", harness.context),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "todo.invalid");
            assert.equal((error as { details?: { reason?: string } }).details?.reason, "push");
            assert.equal((error as { details?: { toolCallBudget?: number } }).details?.toolCallBudget, 5);
            return true;
        },
    );
    await harness.gateway.beforeModelToolCall("local", "todo_report", harness.context);
    await harness.report("reply to pushed comment");
    await harness.gateway.beforeModelToolCall("local", "file_read", harness.context);
});

test("a #stop Comment blocks every model tool until the user queues #resume", async () => {
    const harness = createTodoReportHarness();
    harness.deliverComment("comment-stop", "#stop Stop working now");
    for (const toolName of ["file_read", "todo_report", "environ_remote"]) {
        await assert.rejects(
            harness.gateway.beforeModelToolCall("local", toolName, harness.context),
            (error: unknown) => {
                assert.equal((error as { code?: string }).code, "todo.invalid");
                assert.equal((error as { details?: { reason?: string } }).details?.reason, "stop");
                return true;
            },
        );
    }
    harness.queueComment("comment-resume", "#resume");
    await harness.gateway.beforeModelToolCall("local", "file_read", harness.context);
});

test("failed reports neither spend a token nor satisfy a Comment obligation", async () => {
    const harness = createTodoReportHarness();
    harness.failNextReport();
    await assert.rejects(harness.report("first"), /report failed/u);
    await harness.report("first");
    await harness.report("second");
    await assertRateLimited(harness.report("third"), 30_000);

    harness.deliverComment("comment-failure", "Reply even if persistence fails");
    harness.failNextReport();
    await assert.rejects(harness.report("reply"), /report failed/u);
    await harness.report("reply");
    await harness.gateway.beforeModelToolCall("local", "file_read", harness.context);
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
                }
            }
        })) as never
    );
    const gateway = new McpInstanceGatewayControl({
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry
    });

    await gateway.closeToolSession("session-shared");

    assert.deepEqual(released.sort(), [
        "local-one:session-shared",
        "remote-two:session-shared"
    ]);
});

test("MCP instance lifecycle responses preserve active Todo summaries", async () => {
    const activeTodos = [{
        completed: 1,
        currentItem: "Verify release lifecycle",
        revision: 3,
        status: "in_progress" as const,
        taskId: "release-review",
        title: "Release review",
        total: 2
    }];
    const snapshot = {
        connectionState: "disconnected",
        daemonState: "stopped",
        lastSeq: 4,
        name: "remote-server",
        ready: false,
        status: "stopped"
    };
    let currentSnapshot = snapshot;
    let startCalls = 0;
    const registry = new InstanceRegistry([{
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
                currentSnapshot = { ...snapshot, daemonState: "running", ready: true, status: "ready" };
                return currentSnapshot;
            },
            async stop() {
                currentSnapshot = snapshot;
                return currentSnapshot;
            }
        }
    } as never]);
    const gateway = new McpInstanceGatewayControl({
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry
    });

    assert.deepEqual(
        (await gateway.connectInstance("remote-server", "ctx-one") as { activeTodos?: unknown }).activeTodos,
        activeTodos
    );
    await gateway.connectInstance("remote-server", "ctx-one");
    assert.equal(startCalls, 1);
    assert.deepEqual(
        (await gateway.stopInstance("remote-server") as { activeTodos?: unknown }).activeTodos,
        activeTodos
    );
});

test("MCP instance connect lifecycle uses Context references without adopting an already-ready worker", async () => {
    let ready = false;
    let startCalls = 0;
    let stopCalls = 0;
    const registry = new InstanceRegistry([{
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
            }
        }
    } as never, {
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
            }
        }
    } as never]);
    const gateway = new McpInstanceGatewayControl({
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry
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
