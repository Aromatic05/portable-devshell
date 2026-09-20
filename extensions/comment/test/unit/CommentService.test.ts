import assert from "node:assert/strict";

import { join } from "node:path";
import test from "node:test";

import type { InstanceEventType, JsonValue } from "@portable-devshell/shared";

import {
    CommentService,
    type CommentServiceOptions,
} from "../../src/comment/CommentService.ts";
import { CommentState } from "../../src/comment/CommentState.ts";
import { ConversationStore } from "../../src/conversation/store/ConversationStore.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

function createCommentService(
    root: string,
    appendEvent: CommentServiceOptions["appendEvent"] = async () => undefined,
): CommentService {
    return new CommentService({
        appendEvent,
        instanceName: "alpha",
        store: new ConversationStore({
            filePath: join(root, "conversation.sqlite3"),
            instanceName: "alpha",
            legacyContextMessagesFile: join(root, "context-messages.json"),
        }),
    });
}

test("CommentService merges pending Comments into one call-bound delivery", async () => {
    const root = await createTestTempDirectory("context-message");
    const events: Array<{ data: JsonValue; type: InstanceEventType }> = [];
    const createService = () =>
        createCommentService(
            root,
            async (
                type: Extract<InstanceEventType, `context.message.${string}`>,
                data: JsonValue,
            ) => {
                events.push({ data, type });
            },
        );
    const service = createService();

    const first = await service.queue({
        ctxId: "ctx-a",
        text: "Check the latest failure",
    });
    const followUp = await service.queue({
        ctxId: "ctx-a",
        text: "Then compare the next output",
    });
    const second = await service.queue({
        ctxId: "ctx-b",
        text: "Keep this sent",
    });

    assert.equal(first.status, "sent");
    assert.deepEqual(
        (await service.list()).map((message) => message.status),
        ["sent", "sent", "sent"],
    );
    assert.deepEqual(
        await service.consumePending("ctx-missing", "call-missing"),
        {
            callId: "call-missing",
            messages: [],
        },
    );

    const delivered = await service.consumePending("ctx-a", "call-1");
    assert.equal(delivered.callId, "call-1");
    assert.equal(
        delivered.comment,
        "Check the latest failure\n\nThen compare the next output",
    );
    assert.deepEqual(
        delivered.messages.map((message) => message.text),
        ["Check the latest failure", "Then compare the next output"],
    );
    assert.deepEqual(
        (await service.list()).map((message) => [
            message.id,
            message.status,
            message.callId,
        ]),
        [
            [first.id, "delivered", "call-1"],
            [followUp.id, "delivered", "call-1"],
            [second.id, "sent", undefined],
        ],
    );
    assert.deepEqual(
        (await service.list({ limit: 2 })).map((message) => message.id),
        [followUp.id, second.id],
    );
    assert.deepEqual(
        (await service.list({ before: second.id, limit: 1 })).map(
            (message) => message.id,
        ),
        [followUp.id],
    );
    const byteBounded = await service.list({ maxBytes: 220 });
    assert.equal(
        Buffer.byteLength(JSON.stringify(byteBounded), "utf8") <= 220,
        true,
    );

    const reloaded = createService();
    assert.deepEqual(
        (await reloaded.list()).map((message) => [
            message.id,
            message.status,
            message.callId,
        ]),
        [
            [first.id, "delivered", "call-1"],
            [followUp.id, "delivered", "call-1"],
            [second.id, "sent", undefined],
        ],
    );
    assert.deepEqual(
        events.map((event) => event.type),
        [
            "context.message.queued",
            "context.message.queued",
            "context.message.queued",
            "context.message.delivered",
        ],
    );
    const deliveryEvent = events.at(-1)?.data as Record<string, JsonValue>;
    assert.equal(deliveryEvent.callId, "call-1");
    assert.deepEqual(deliveryEvent.ids, [first.id, followUp.id]);
});

test("CommentService marks a queued message failed when its audit event cannot be recorded", async () => {
    const root = await createTestTempDirectory("context-message-failure");
    const service = createCommentService(root, async (type) => {
        if (type === "context.message.queued")
            throw new Error("audit unavailable");
    });

    await assert.rejects(
        service.queue({ ctxId: "ctx-a", text: "Do not lose this message" }),
        /audit unavailable/u,
    );
    const [record] = await service.list("ctx-a");
    assert.equal(record?.status, "failed");
    assert.equal(record?.error, "audit unavailable");
    assert.equal(await service.pendingPushMessage("ctx-a"), undefined);
    assert.deepEqual(await service.reviewToolCall("ctx-a", "file_read"), {
        kind: "allow",
    });
});

test("CommentService restores the previous push state when a later Comment fails to queue", async () => {
    const root = await createTestTempDirectory("context-message-push-rollback");
    let failQueue = false;
    const service = createCommentService(root, async (type) => {
        if (failQueue && type === "context.message.queued")
            throw new Error("audit unavailable");
    });

    await service.queue({ ctxId: "ctx-a", text: "#push 报告进度" });
    assert.deepEqual(await service.reviewToolCall("ctx-a", "file_read"), {
        kind: "allow",
    });
    failQueue = true;
    await assert.rejects(
        service.queue({ ctxId: "ctx-a", text: "这条不应该进入 push_message" }),
        /audit unavailable/u,
    );
    assert.equal(await service.pendingPushMessage("ctx-a"), "#push 报告进度");
    for (let index = 0; index < 4; index += 1) {
        assert.deepEqual(await service.reviewToolCall("ctx-a", "file_read"), {
            kind: "allow",
        });
    }
    assert.equal(
        (await service.reviewToolCall("ctx-a", "file_read")).kind,
        "push",
    );
});

test("CommentService fails undelivered Comments when their Context is retired", async () => {
    const root = await createTestTempDirectory("context-message-retired");
    const events: Array<{ data: JsonValue; type: InstanceEventType }> = [];
    const service = createCommentService(root, async (type, data) => {
        events.push({ data, type });
    });
    const first = await service.queue({
        ctxId: "ctx-retired",
        text: "Do not deliver later",
    });
    await service.queue({ ctxId: "ctx-live", text: "Keep live" });

    const failed = await service.failPending(
        "ctx-retired",
        "Context ctx-retired was disabled before Comment delivery.",
    );

    assert.deepEqual(
        failed.map((message) => [message.id, message.status]),
        [[first.id, "failed"]],
    );
    assert.match(failed[0]?.error ?? "", /disabled before Comment delivery/u);
    assert.deepEqual(
        (await service.list())
            .map((message) => [message.ctxId, message.status])
            .sort((left, right) =>
                String(left[0]).localeCompare(String(right[0])),
            ),
        [
            ["ctx-live", "sent"],
            ["ctx-retired", "failed"],
        ],
    );
    assert.equal(
        events.filter((event) => event.type === "context.message.failed")
            .length,
        1,
    );
    assert.deepEqual(await service.consumePending("ctx-retired", "call-late"), {
        callId: "call-late",
        messages: [],
    });
});

test("CommentService failAllPending retires all undelivered Comments for instance deletion", async () => {
    const root = await createTestTempDirectory("context-message-delete");
    const service = createCommentService(root);
    await service.queue({ ctxId: "ctx-a", text: "First" });
    const delivered = await service.queue({
        ctxId: "ctx-b",
        text: "#stop Delivered history",
    });
    await service.consumePending("ctx-b", "call-b");
    await service.queue({ ctxId: "ctx-c", text: "Second" });
    assert.equal(
        (await service.reviewToolCall("ctx-b", "file_read")).kind,
        "stop",
    );

    const failed = await service.failAllPending(
        "Instance alpha was deleted before Comment delivery.",
    );

    assert.deepEqual(failed.map((message) => message.ctxId).sort(), [
        "ctx-a",
        "ctx-c",
    ]);
    assert.equal(
        failed.every((message) => message.status === "failed"),
        true,
    );
    assert.equal((await service.list("ctx-b"))[0]?.id, delivered.id);
    assert.equal((await service.list("ctx-b"))[0]?.status, "delivered");
    assert.deepEqual(await service.reviewToolCall("ctx-b", "file_read"), {
        kind: "allow",
    });
});

test("CommentService retirement permanently fences stale service references", async () => {
    const root = await createTestTempDirectory(
        "context-message-retirement-fence",
    );
    const service = createCommentService(root);
    await service.queue({ ctxId: "ctx-a", text: "Pending before retirement" });

    await service.retire(
        "Instance alpha was disabled before Comment delivery.",
    );

    for (const operation of [
        async () => await service.queue({ ctxId: "ctx-a", text: "late" }),
        async () => await service.list("ctx-a"),
        async () => await service.reviewToolCall("ctx-a", "file_read"),
        async () => await service.consumePending("ctx-a", "call-late"),
    ]) {
        await assert.rejects(operation, /not found or is disabled/u);
    }

    const store = new ConversationStore({
        filePath: join(root, "conversation.sqlite3"),
        instanceName: "alpha",
    });
    assert.deepEqual(
        store
            .listComments({ ctxId: "ctx-a" })
            .map((comment) => [comment.text, comment.status]),
        [["Pending before retirement", "failed"]],
    );
    store.close();
});

test("CommentService delivery event failure never blocks or requeues a completed call", async () => {
    const root = await createTestTempDirectory("context-message-retry");
    const service = createCommentService(root, async (type) => {
        if (type === "context.message.delivered") {
            throw new Error("audit temporarily unavailable");
        }
    });
    const queued = await service.queue({
        ctxId: "ctx-a",
        text: "Retry this message",
    });

    const delivered = await service.consumePending("ctx-a", "call-1");
    assert.deepEqual(
        delivered.messages.map((message) => message.id),
        [queued.id],
    );
    assert.equal(delivered.comment, "Retry this message");
    assert.deepEqual(
        (await service.list("ctx-a")).map((message) => [
            message.status,
            message.callId,
        ]),
        [["delivered", "call-1"]],
    );
    assert.deepEqual(await service.consumePending("ctx-a", "call-2"), {
        callId: "call-2",
        messages: [],
    });
});

test("CommentService keeps #stop durable and delivers #resume before tools continue", async () => {
    const root = await createTestTempDirectory("context-message-stop-control");
    const service = createCommentService(root);
    const stop = await service.queue({
        ctxId: "ctx-a",
        text: "#stop Stop before the next tool",
    });

    assert.deepEqual(
        await service.reviewToolCall("ctx-a", "file_read", "request-stop"),
        {
            comment: "#stop Stop before the next tool",
            commentId: stop.id,
            kind: "stop",
        },
    );
    const reloaded = createCommentService(root);
    assert.equal(
        (await reloaded.reviewToolCall("ctx-a", "file_read")).kind,
        "stop",
    );
    const resume = await reloaded.queue({
        ctxId: "ctx-a",
        text: "#resume Continue, but do not delete files",
    });
    assert.deepEqual(
        await reloaded.reviewToolCall("ctx-a", "file_read", "request-resume"),
        {
            comment: "#resume Continue, but do not delete files",
            commentId: resume.id,
            kind: "resume",
        },
    );
    assert.deepEqual(await reloaded.reviewToolCall("ctx-a", "file_read"), {
        kind: "allow",
    });
});

test("CommentService delivers queued Stop-era messages through Resume without reactivating an old Stop", async () => {
    const root = await createTestTempDirectory(
        "context-message-stop-resume-queued",
    );
    const service = createCommentService(root);
    await service.queue({ ctxId: "ctx-a", text: "#stop Stop now" });
    await service.queue({ ctxId: "ctx-a", text: "Also keep this constraint" });
    const resume = await service.queue({
        ctxId: "ctx-a",
        text: "#resume Continue carefully",
    });

    assert.deepEqual(
        await service.reviewToolCall(
            "ctx-a",
            "file_read",
            "request-resume-batch",
        ),
        {
            comment:
                "#stop Stop now\n\nAlso keep this constraint\n\n#resume Continue carefully",
            commentId: resume.id,
            kind: "resume",
        },
    );
    assert.deepEqual(await service.reviewToolCall("ctx-a", "file_read"), {
        kind: "allow",
    });
    assert.deepEqual(await service.consumePending("ctx-a", "next-call"), {
        callId: "next-call",
        messages: [],
    });
});

test("CommentService accumulates push_message and decrements ddl for tools and later Comments", async () => {
    const root = await createTestTempDirectory("context-message-push-control");
    const service = createCommentService(root);
    const firstPush = await service.queue({
        ctxId: "ctx-a",
        text: "#push 报告当前进度",
    });
    await service.consumePending("ctx-a", "delivery-one");
    assert.equal(
        await service.pendingPushMessage("ctx-a"),
        "#push 报告当前进度",
    );
    for (let index = 0; index < 2; index += 1) {
        assert.deepEqual(await service.reviewToolCall("ctx-a", "file_read"), {
            kind: "allow",
        });
    }
    await service.queue({
        ctxId: "ctx-a",
        text: "还要说明目前的阻塞点",
    });
    await service.consumePending("ctx-a", "delivery-two");
    const secondPush = await service.queue({
        ctxId: "ctx-a",
        text: "#push 以及下一步准备做什么",
    });
    await service.consumePending("ctx-a", "delivery-three");
    assert.notEqual(firstPush.id, secondPush.id);

    const reloaded = createCommentService(root);
    assert.deepEqual(await reloaded.reviewToolCall("ctx-a", "file_read"), {
        kind: "allow",
    });
    const blocked = await reloaded.reviewToolCall("ctx-a", "file_read");
    assert.deepEqual(blocked, {
        comment:
            "#push 报告当前进度\n\n还要说明目前的阻塞点\n\n#push 以及下一步准备做什么",
        commentId: secondPush.id,
        kind: "push",
        toolCallBudget: 5,
    });
});

test("CommentService starts #push at ddl 5", async () => {
    const root = await createTestTempDirectory(
        "context-message-push-without-reply",
    );
    const service = createCommentService(root);
    const push = await service.queue({
        ctxId: "ctx-a",
        text: "#push 报告进度",
    });
    await service.consumePending("ctx-a", "push-only-delivery");

    assert.equal(await service.pendingReplyCommentId("ctx-a"), undefined);
    assert.equal(await service.pendingPushMessage("ctx-a"), "#push 报告进度");
    for (let index = 0; index < 5; index += 1) {
        assert.deepEqual(await service.reviewToolCall("ctx-a", "file_read"), {
            kind: "allow",
        });
    }
    assert.deepEqual(await service.reviewToolCall("ctx-a", "file_read"), {
        comment: "#push 报告进度",
        commentId: push.id,
        kind: "push",
        toolCallBudget: 5,
    });
});

test("CommentState retains all pending messages while bounding terminal history", () => {
    const state = new CommentState();
    const messages = [
        ...Array.from({ length: 5 }, (_, index) => ({
            createdAt: new Date(index).toISOString(),
            ctxId: "ctx-pending",
            id: `pending-${index}`,
            instance: "alpha",
            status: "pending" as const,
            text: `pending ${index}`,
        })),
        ...Array.from({ length: 1_100 }, (_, index) => ({
            createdAt: new Date(10_000 + index).toISOString(),
            ctxId: "ctx-terminal",
            deliveredAt: new Date(20_000 + index).toISOString(),
            id: `delivered-${index}`,
            instance: "alpha",
            status: "delivered" as const,
            text: `delivered ${index}`,
        })),
    ];

    const compacted = state.compact({ messages, version: 1 });
    assert.equal(
        compacted.messages.filter((message) => message.status === "pending")
            .length,
        5,
    );
    assert.equal(
        compacted.messages.filter((message) => message.status !== "pending")
            .length,
        256,
    );
    assert.equal(
        compacted.messages.some((message) => message.id === "delivered-1099"),
        true,
    );
    assert.equal(
        compacted.messages.some((message) => message.id === "delivered-0"),
        false,
    );
});
