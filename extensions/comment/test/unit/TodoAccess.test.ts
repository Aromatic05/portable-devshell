import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { type JsonValue } from "@portable-devshell/shared";
import { TodoService } from "../../../../packages/core/src/task/todo/index.ts";
import { installTodoTools } from "../../../../packages/core/src/task/todo/tool/Runtime.ts";
import { round4Target } from "../../../../packages/core/test/unit/tool/Round4Harness.ts";
import type { TaskApi } from "../../../../packages/core/src/task/Api.ts";
import { createCommentDelivery, createCommentTodoAccess, createCommentTodoInvalid, createCommentToolCallGate } from "../../src/index.ts";
import { CommentService } from "../../src/comment/CommentService.ts";
import { CommentReportService } from "../../src/comment/report/Service.ts";
import { MessageService } from "../../src/message/MessageService.ts";
import { MessageStore } from "../../src/message/store/MessageStore.ts";
import { databaseConnection } from "../helpers/Database.ts";

test("Todo pipeline reaches CAS after repeated reads/writes, recovers conflicts, and still bans invalid writes", async (t) => {
    const h = await round4Target();
    let now = 0;
    const messagePath = join(h.directory, "message.sqlite3");
    const store = new MessageStore({ filePath: messagePath, instanceName: h.instanceName,
        openDatabase: () => databaseConnection(messagePath) });
    t.after(async () => { await store.close(); await h.close(); });
    const comment = new CommentService({ instanceName: h.instanceName, store, async appendEvent() {} });
    const messageHistory = new MessageService({ store, instanceName: h.instanceName });
    const report = new CommentReportService({
        comment,
        messageHistory,
        now: () => now,
    });
    const filePath = join(h.directory, "todo.json");
    const events: string[] = [];
    const todo = new TodoService({ instanceName: h.instanceName, filePath,
        async appendEvent(type) { events.push(type); } });
    installTodoTools(h.runtime.hooks, { todo } as unknown as TaskApi);
    const access = createCommentTodoAccess({ async beforeTodoToolCall(_instance, ctxId, toolName) {
        await report.beforeTodoToolCall(ctxId, toolName);
    } });
    const invalid = createCommentTodoInvalid({ recordTodoInvalid(_instance, ctxId) { report.recordTodoInvalid(ctxId); } });
    const gate = createCommentToolCallGate({ async reviewToolCall(_instance, ctxId, toolName, callId) {
        return comment.reviewToolCall(ctxId, toolName, callId);
    } });
    const delivery = createCommentDelivery({ async consumePending(_instance, ctxId, callId) {
        return comment.consumePending(ctxId, callId);
    } });
    const invocation = { signal: new AbortController().signal, async requestInterface(): Promise<never> { throw new Error("No host interface expected"); } };
    h.runtime.hooks.registerReview({ hook: "comment-control", id: "001", review: (input) => gate(input, invocation) });
    h.runtime.hooks.registerExecute("todo_report", async (callId, input, value) => {
        await report.report(value.context.ctxId!, (input as { message: string }).message, callId);
        return {};
    });
    h.runtime.hooks.registerContributor(() => ({ rewrites: [
        { hook: "todo-access", id: "001", async rewrite(input) {
            assert.equal(await access(input, invocation), input.value);
            return input.value;
        } },
        { hook: "todo-invalid", id: "002", async rewrite(input) {
            assert.equal(await invalid(input, invocation), input.value);
            return input.value;
        } },
        { hook: "comment-delivery", id: "003", async rewrite(input) {
            const value = await delivery(input, invocation);
            return { ...value, context: input.value.context };
        } },
    ], release() {} }));
    const call = (name: string, input: JsonValue, ctxId = "ctx-todo") =>
        h.runtime.api.call(h.instanceName, name, input, { source: "mcp", ctxId });
    const plan = (content: string, revision: number, taskId?: string) => ({
        title: "Cross-client CAS", revision, ...(taskId === undefined ? {} : { taskId }),
        todos: [{ id: "verify", content, status: "in_progress" }],
    });
    await comment.queue({ ctxId: "ctx-todo", text: "Inspect the revision conflict" });
    const created = await call("todo_write", plan("step-0", 0)) as { taskId: string; revision: number; comment: string[] };
    assert.equal(created.revision, 1);
    assert.deepEqual(created.comment, ["Inspect the revision conflict"]);
    await call("todo_report", { message: "Inspecting CAS and conflict recovery" });
    assert.equal((await messageHistory.list({ ctxId: "ctx-todo" })).at(-1)?.kind, "report");
    assert.equal((await comment.pendingReport("ctx-todo")).replyCommentId, undefined);
    const updated = await call("todo_write", plan("step-1", 1, created.taskId)) as { revision: number };
    assert.equal(updated.revision, 2);
    for (let index = 0; index < 4; index += 1) {
        await assert.rejects(call("todo_write", plan(`stale-${index}`, 1, created.taskId)), { code: "todo.revisionConflict" });
        assert.equal((await call("todo_read", { taskId: created.taskId }) as { revision: number }).revision, 2);
    }
    const recovered = await call("todo_write", plan("recovered", 2, created.taskId)) as { revision: number };
    assert.equal(recovered.revision, 3);
    const concurrent = await Promise.allSettled([
        call("todo_write", plan("parallel-a", 3, created.taskId)),
        call("todo_write", plan("parallel-b", 3, created.taskId)),
    ]);
    assert.equal(concurrent[0]!.status, "fulfilled");
    assert.equal(concurrent[1]!.status, "rejected");
    assert.ok(concurrent[1]!.status === "rejected");
    assert.equal(concurrent[1]!.reason.code, "todo.revisionConflict");
    const current = await todo.read({ taskId: created.taskId });
    assert.equal(current.revision, 4);
    assert.equal(current.items[0]?.content, "parallel-a");
    assert.deepEqual(events, ["todo.created", "todo.updated", "todo.updated", "todo.updated"]);
    const disk = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(disk.active[0].revision, 4);

    // Duplicate item IDs violate a real domain invariant; conflicts are
    // recoverable and must not count toward the invalid-operation ban above.
    for (let index = 0; index < 3; index += 1) {
        const invalidPlan = plan("invalid", 4, created.taskId);
        invalidPlan.todos.push({ ...invalidPlan.todos[0]!, content: "duplicate" });
        await assert.rejects(call("todo_write", invalidPlan), { code: "todo.invalid" });
    }
    await assert.rejects(call("todo_read", { taskId: created.taskId }), { code: "todo.invalid" });
    await assert.rejects(call("todo_write", plan("blocked", 4, created.taskId)), { code: "todo.invalid" });
    assert.equal((await todo.read({ taskId: created.taskId })).revision, 4);
    assert.equal((await call("todo_read", { taskId: created.taskId }, "other-context") as { revision: number }).revision, 4);
    now = 300_000;
    assert.equal((await call("todo_write", plan("after-ban", 4, created.taskId)) as { revision: number }).revision, 5);
    const reloaded = new TodoService({ instanceName: h.instanceName, filePath, async appendEvent() {} });
    assert.equal((await reloaded.read({ taskId: created.taskId })).items[0]?.content, "after-ban");
    const records = await h.history.read({ ctxId: "ctx-todo" });
    assert.equal(records.filter((record) => record.toolName === "todo_write" && record.status === "completed").length, 5);
    assert.equal(records.filter((record) => record.error === "todo.revisionConflict").length, 5);
    const beforeAcknowledgement = await readFile(filePath, "utf8");
    const inode = (await stat(filePath)).ino;
    const eventCount = events.length;
    await comment.queue({ ctxId: "ctx-todo", text: "Acknowledge the unchanged plan" });
    const acknowledged = await call("todo_write", plan("after-ban", 5, created.taskId)) as {
        revision: number; comment: string[];
    };
    assert.equal(acknowledged.revision, 5);
    assert.deepEqual(acknowledged.comment, ["Acknowledge the unchanged plan"]);
    assert.equal(await readFile(filePath, "utf8"), beforeAcknowledgement);
    assert.equal((await stat(filePath)).ino, inode);
    assert.equal(events.length, eventCount);
    assert.ok((await comment.pendingReport("ctx-todo")).replyCommentId);
    await call("todo_report", { message: "Acknowledged; the plan remains current" });
    assert.equal((await comment.pendingReport("ctx-todo")).replyCommentId, undefined);
    await comment.queue({ ctxId: "ctx-todo", text: "#stop" });
    await assert.rejects(call("todo_write", plan("stopped", 5, created.taskId)), { code: "core.toolCallRejected" });
    assert.equal((await todo.read({ taskId: created.taskId })).revision, 5);
    await comment.queue({ ctxId: "ctx-todo", text: "#resume" });
    await assert.rejects(call("todo_read", { taskId: created.taskId }), { code: "core.toolCallRejected" });
    assert.equal((await call("todo_read", { taskId: created.taskId }) as { revision: number }).revision, 5);
});
