import assert from "node:assert/strict";

import { join } from "node:path";
import test from "node:test";

import type { InstanceEventType, JsonValue } from "@portable-devshell/shared";

import { ContextMessageService } from "../../src/instance/context/ContextMessageService.ts";
import { ContextMessageState } from "../../src/instance/context/ContextMessageState.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("ContextMessageService merges pending Comments into one call-bound delivery", async () => {
    const root = await createTestTempDirectory("context-message");
    const events: Array<{ data: JsonValue; type: InstanceEventType }> = [];
    const options = {
        appendEvent: async (
            type: Extract<InstanceEventType, `context.message.${string}`>,
            data: JsonValue,
        ) => {
            events.push({ data, type });
        },
        filePath: join(root, "context-messages.json"),
        instanceName: "alpha",
    };
    const service = new ContextMessageService(options);

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
    assert.deepEqual(await service.consumePending("ctx-missing", "call-missing"), {
        callId: "call-missing",
        messages: [],
    });

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
        (await service.list()).map((message) => [message.id, message.status, message.callId]),
        [
            [first.id, "delivered", "call-1"],
            [followUp.id, "delivered", "call-1"],
            [second.id, "sent", undefined],
        ],
    );

    const reloaded = new ContextMessageService(options);
    assert.deepEqual(
        (await reloaded.list()).map((message) => [message.id, message.status, message.callId]),
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

test("ContextMessageService marks a queued message failed when its audit event cannot be recorded", async () => {
    const root = await createTestTempDirectory("context-message-failure");
    const service = new ContextMessageService({
        appendEvent: async (type) => {
            if (type === "context.message.queued")
                throw new Error("audit unavailable");
        },
        filePath: join(root, "context-messages.json"),
        instanceName: "alpha",
    });

    await assert.rejects(
        service.queue({ ctxId: "ctx-a", text: "Do not lose this message" }),
        /audit unavailable/u,
    );
    const [record] = await service.list("ctx-a");
    assert.equal(record?.status, "failed");
    assert.equal(record?.error, "audit unavailable");
});

test("ContextMessageService fails undelivered Comments when their Context is retired", async () => {
    const root = await createTestTempDirectory("context-message-retired");
    const events: Array<{ data: JsonValue; type: InstanceEventType }> = [];
    const service = new ContextMessageService({
        appendEvent: async (type, data) => { events.push({ data, type }); },
        filePath: join(root, "context-messages.json"),
        instanceName: "alpha",
    });
    const first = await service.queue({ ctxId: "ctx-retired", text: "Do not deliver later" });
    await service.queue({ ctxId: "ctx-live", text: "Keep live" });

    const failed = await service.failPending(
        "ctx-retired",
        "Context ctx-retired was disabled before Comment delivery.",
    );

    assert.deepEqual(failed.map((message) => [message.id, message.status]), [[first.id, "failed"]]);
    assert.match(failed[0]?.error ?? "", /disabled before Comment delivery/u);
    assert.deepEqual(
        (await service.list())
            .map((message) => [message.ctxId, message.status])
            .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
        [["ctx-live", "sent"], ["ctx-retired", "failed"]],
    );
    assert.equal(
        events.filter((event) => event.type === "context.message.failed").length,
        1,
    );
    assert.deepEqual(await service.consumePending("ctx-retired", "call-late"), {
        callId: "call-late",
        messages: [],
    });
});

test("ContextMessageService delivery event failure never blocks or requeues a completed call", async () => {
    const root = await createTestTempDirectory("context-message-retry");
    const service = new ContextMessageService({
        appendEvent: async (type) => {
            if (type === "context.message.delivered") {
                throw new Error("audit temporarily unavailable");
            }
        },
        filePath: join(root, "context-messages.json"),
        instanceName: "alpha",
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
        (await service.list("ctx-a")).map((message) => [message.status, message.callId]),
        [["delivered", "call-1"]],
    );
    assert.deepEqual(await service.consumePending("ctx-a", "call-2"), {
        callId: "call-2",
        messages: [],
    });
});

test("ContextMessageState retains all pending messages while bounding terminal history", () => {
    const state = new ContextMessageState();
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
        1_000,
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
