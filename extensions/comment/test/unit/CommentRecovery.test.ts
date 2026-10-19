import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { CommentService } from "../../src/comment/CommentService.ts";
import { MessageStore } from "../../src/message/store/MessageStore.ts";
import { databaseConnection } from "../helpers/Database.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

async function fixture(appendEvent = async (_type: string) => {}) {
    const root = await createTestTempDirectory("comment-recovery");
    const filePath = join(root, "message.sqlite3");
    const store = new MessageStore({
        filePath,
        instanceName: "alpha",
        openDatabase: () => databaseConnection(filePath),
    });
    const service = new CommentService({ instanceName: "alpha", store, appendEvent });
    return { service, store };
}

test("Concurrent Comment consumers deliver each message once without crossing Contexts", async (t) => {
    const events: string[] = [];
    const { service, store } = await fixture(async (type) => { events.push(type); });
    t.after(() => store.close());
    const first = await service.queue({ ctxId: "ctx-a", text: "First constraint" });
    const second = await service.queue({ ctxId: "ctx-a", text: "Second constraint" });
    const other = await service.queue({ ctxId: "ctx-b", text: "Private to B" });

    const deliveries = await Promise.all([
        service.consumePending("ctx-a", "call-a1"),
        service.consumePending("ctx-a", "call-a2"),
    ]);
    assert.deepEqual(deliveries.map((result) => result.messages.length).sort(), [0, 2]);
    assert.deepEqual(deliveries.flatMap((result) => result.messages.map((message) => message.id)),
        [first.id, second.id]);
    assert.equal(events.filter((type) => type === "context.message.delivered").length, 1);
    assert.deepEqual((await service.list("ctx-b")).map(({ id, status, callId }) =>
        [id, status, callId]), [[other.id, "sent", undefined]]);

    await store.close();
    const reloaded = new CommentService({ instanceName: "alpha", store, appendEvent: async () => {} });
    assert.deepEqual(await reloaded.consumePending("ctx-a", "replayed-call"),
        { callId: "replayed-call", messages: [] });
    assert.deepEqual((await reloaded.consumePending("ctx-b", "call-b")).messages.map(({ id }) => id),
        [other.id]);
});

test("Failed Resume preserves a durable Stop while another Context continues", async (t) => {
    let failQueue = false;
    const { service, store } = await fixture(async (type) => {
        if (failQueue && type === "context.message.queued") throw new Error("audit disconnected");
    });
    t.after(() => store.close());
    const stop = await service.queue({ ctxId: "ctx-a", text: "#stop Wait for review" });
    await service.reviewToolCall("ctx-a", "file_read", "stop-delivery");
    failQueue = true;
    await assert.rejects(service.queue({ ctxId: "ctx-a", text: "#resume Unrecorded approval" }),
        /audit disconnected/u);
    await store.close();

    const reloaded = new CommentService({ instanceName: "alpha", store, appendEvent: async () => {} });
    assert.deepEqual(await reloaded.reviewToolCall("ctx-a", "file_read"),
        { kind: "stop", commentId: stop.id });
    await reloaded.queue({ ctxId: "ctx-b", text: "#resume B only" });
    await reloaded.consumePending("ctx-b", "call-b");
    assert.deepEqual(await reloaded.reviewToolCall("ctx-b", "file_read"), { kind: "allow" });
    assert.deepEqual(await reloaded.reviewToolCall("ctx-a", "file_read"),
        { kind: "stop", commentId: stop.id });

    const resume = await reloaded.queue({ ctxId: "ctx-a", text: "#resume Approved" });
    assert.deepEqual(await reloaded.reviewToolCall("ctx-a", "file_read", "resume-delivery"),
        { kind: "resume", commentId: resume.id, comment: "#resume Approved" });
    assert.deepEqual(await reloaded.reviewToolCall("ctx-a", "file_read"), { kind: "allow" });
    assert.deepEqual((await reloaded.list("ctx-a")).map(({ status }) => status),
        ["delivered", "failed", "delivered"]);
});

test("Concurrent reviews preserve the Push budget across restart and a real report clears it", async (t) => {
    const { service, store } = await fixture();
    t.after(() => store.close());
    const push = await service.queue({ ctxId: "ctx-a", text: "#push Report progress" });
    await service.consumePending("ctx-a", "push-delivery");
    assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () =>
        service.reviewToolCall("ctx-a", "file_read"))), Array.from({ length: 5 }, () => ({ kind: "allow" })));
    await store.close();

    const reloaded = new CommentService({ instanceName: "alpha", store, appendEvent: async () => {} });
    assert.deepEqual(await reloaded.reviewToolCall("ctx-b", "file_read"), { kind: "allow" });
    assert.deepEqual(await reloaded.reviewToolCall("ctx-a", "todo_report"), { kind: "allow" });
    assert.deepEqual(await reloaded.reviewToolCall("ctx-a", "file_read"), {
        kind: "push", commentId: push.id, comment: push.text, toolCallBudget: 5,
    });
    const pending = await reloaded.pendingReport("ctx-a");
    await store.appendReport({ callId: "report-a", ctxId: "ctx-a", createdAt: new Date().toISOString(),
        text: "Progress reported", ...pending });
    assert.deepEqual(await reloaded.pendingReport("ctx-a"), {});
    assert.deepEqual(await reloaded.reviewToolCall("ctx-a", "file_read"), { kind: "allow" });
});
