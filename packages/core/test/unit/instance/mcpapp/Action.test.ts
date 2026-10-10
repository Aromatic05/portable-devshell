import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createToolCallRuntime, type JsonValue } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { TodoService } from "../../../../src/task/todo/index.ts";
import { mcpAppActionDefinition } from "../../../../src/instance/mcpapp/Definition.ts";
import { installMcpAppAction } from "../../../../src/instance/mcpapp/index.ts";

test("native MCP App action passes Hook review, executes only for matching Context and revision", async () => {
    const recorded: string[] = [];
    const runtime = createToolCallRuntime({
        resolveTarget: () => ({
            async dispatch(request) {
                recorded.push("target");
                assert.ok(request.execute, "Instance must own Execute");
                // Native MCPApp actions return raw JSON, never a presentation.
                return await request.execute(request.callId, request.value.payload, request.value) as JsonValue;
            },
        }),
    });
    const actions: Array<{ ctxId: string; taskId: string; expectedRevision: number | undefined }> = [];
    const approvalActions: string[] = [];
    const domain = {
        approval: {
            async getApproval(id: string) {
                return { approvalId: id, ctxId: "ctx-a", status: "pending", workspace: "/repo" };
            },
            async decideApproval(id: string) { approvalActions.push(id); return {} as never; },
        },
        task: {
            goal: {
                async read(ctxId: string) {
                    return ctxId === "ctx-a"
                        ? { goalId: "goal-a", workspace: "/repo", revision: 2 }
                        : undefined;
                },
                async manage(ctxId: string, input: { expectedRevision?: number }) {
                    recorded.push(`goal:${ctxId}:${input.expectedRevision}`);
                    return {} as never;
                },
            },
            todo: {
                async read(selector?: unknown) {
                    assert.equal(selector, undefined, "Context ownership requires active task summaries");
                    return { tasks: [{ taskId: "task-a", ctxId: "ctx-a", revision: 3 }] };
                },
                async control(taskId: string, _op: string, ctxId: string, expectedRevision?: number) {
                    actions.push({ taskId, ctxId, expectedRevision });
                    return {} as never;
                },
            },
        },
    };
    assert.deepEqual(mcpAppActionDefinition()._meta, {
        ui: { visibility: ["app"] },
        devshell: { mcp: { title: "Workspace action", annotations: {
            destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false,
        } } },
    });
    runtime.hooks.registerReview({
        hook: "100-test", id: "verify-review",
        review(input) { recorded.push(`review:${input.value.toolName}`); return { decision: "continue" }; },
    });
    const stop = installMcpAppAction(runtime.hooks, domain as never);
    const call = async (input: JsonValue, ctxId = "ctx-a", source: "mcp" | "cli" = "mcp") =>
        await runtime.api.call("local", "mcpapp_action", {
            ...(input as Record<string, JsonValue>),
            requestId: "test-request-uuid-12345678",
        }, { ctxId, workspace: "/repo", source });
    try {
        assert.deepEqual(await call({ itemId: "task-a", actionId: "task-pause", expectedRevision: 3 }),
            { status: "applied", itemId: "task-a", actionId: "task-pause" });
        assert.deepEqual(actions, [{ taskId: "task-a", ctxId: "ctx-a", expectedRevision: 3 }]);
        assert.deepEqual(recorded.slice(0, 2), ["review:mcpapp_action", "target"]);
        await assert.rejects(call({ itemId: "task-a", actionId: "task-pause", expectedRevision: 3 }, "ctx-b"), /unavailable/u);
        await assert.rejects(call({ itemId: "task-a", actionId: "task-pause" }), /revision/u);
        await assert.rejects(call({ itemId: "task-a", actionId: "task-pause", expectedRevision: 3 }, "ctx-a", "cli"), /validated MCP Context/u);
        assert.equal(actions.length, 1);
        assert.deepEqual(await call({ itemId: "goal-a", actionId: "goal-resume", expectedRevision: 2 }),
            { status: "applied", itemId: "goal-a", actionId: "goal-resume" });
        assert.equal(recorded.includes("goal:ctx-a:2"), true);
        await assert.rejects(call({ itemId: "goal-a", actionId: "goal-resume", expectedRevision: 2 }, "ctx-b"), /Goal is unavailable/u);
        assert.deepEqual(await call({ itemId: "approval-a", actionId: "approve" }),
            { status: "applied", itemId: "approval-a", actionId: "approve" });
        assert.deepEqual(approvalActions, ["approval-a"]);
        await assert.rejects(call({ itemId: "approval-a", actionId: "approve" }, "ctx-b"), /approval is no longer pending/u);
    } finally {
        stop();
        runtime.close();
    }
});

test("MCPApp Task Action validates Context and revision against persisted TodoService", async () => {
    const dir = await createTestTempDirectory("mcpapp-action-todo");
    const todo = new TodoService({
        filePath: join(dir, "todo.json"), instanceName: "local",
        appendEvent: async () => undefined,
    });
    const created = await todo.write({ revision: 0, title: "Context-owned task", todos: [
        { id: "work", content: "Verify Context ownership", status: "in_progress" },
    ] }, "ctx-owner");
    const taskId = created.taskId;
    assert.ok(taskId);
    const runtime = createToolCallRuntime({ resolveTarget: () => ({
        async dispatch(request) {
            assert.ok(request.execute);
            return await request.execute(request.callId, request.value.payload, request.value) as JsonValue;
        },
    }) });
    const stop = installMcpAppAction(runtime.hooks, {
        approval: {}, task: { todo },
    } as never);
    const call = (ctxId: string, revision = created.revision) => runtime.api.call("local", "mcpapp_action", {
        actionId: "task-pause", itemId: taskId, expectedRevision: revision,
        requestId: "test-real-todo-action-12345678",
    }, { ctxId, workspace: "/repo", source: "mcp" });
    try {
        await assert.rejects(call("ctx-other"), /unavailable/u);
        assert.equal((await todo.read({ taskId: created.taskId })).pausedAt, undefined);
        assert.deepEqual(await call("ctx-owner"), {
            status: "applied", itemId: created.taskId, actionId: "task-pause",
        });
        const paused = await todo.read({ taskId: created.taskId });
        assert.ok(paused.pausedAt);
        assert.equal(paused.revision, created.revision + 1);
        await assert.rejects(call("ctx-owner"), /revision/u);
        assert.equal((await todo.read({ taskId: created.taskId })).revision, paused.revision);
    } finally {
        stop();
        runtime.close();
    }
});
