import assert from "node:assert/strict";

import { join } from "node:path";
import test from "node:test";

import type { InstanceEventType, JsonValue } from "@portable-devshell/shared";

import { ContextMessageService } from "../../src/instance/context/ContextMessageService.ts";
import { ContextMessageState } from "../../src/instance/context/ContextMessageState.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("ContextMessageService persists pending messages and marks only the matching context delivered", async () => {
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
    const second = await service.queue({
        ctxId: "ctx-b",
        text: "Keep this pending",
    });

    assert.equal(first.status, "pending");
    assert.deepEqual(
        (await service.list()).map((message) => message.status),
        ["pending", "pending"],
    );
    assert.deepEqual(await service.readPending("ctx-missing"), {
        messages: [],
    });

    const delivered = await service.readPending("ctx-a");
    assert.deepEqual(
        delivered.messages.map((message) => message.text),
        ["Check the latest failure"],
    );
    assert.deepEqual(
        (await service.list()).map((message) => [message.id, message.status]),
        [
            [first.id, "delivered"],
            [second.id, "pending"],
        ],
    );

    const reloaded = new ContextMessageService(options);
    assert.deepEqual(
        (await reloaded.list()).map((message) => [message.id, message.status]),
        [
            [first.id, "delivered"],
            [second.id, "pending"],
        ],
    );
    assert.deepEqual(
        events.map((event) => event.type),
        [
            "context.message.queued",
            "context.message.queued",
            "context.message.delivered",
        ],
    );
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

test("ContextMessageService keeps a message pending when delivery audit fails and retries it", async () => {
    const root = await createTestTempDirectory("context-message-retry");
    let failDelivery = true;
    const service = new ContextMessageService({
        appendEvent: async (type) => {
            if (type === "context.message.delivered" && failDelivery) {
                failDelivery = false;
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

    await assert.rejects(
        service.readPending("ctx-a"),
        /audit temporarily unavailable/u,
    );
    assert.equal((await service.list("ctx-a"))[0]?.status, "pending");

    const retried = await service.readPending("ctx-a");
    assert.deepEqual(
        retried.messages.map((message) => message.id),
        [queued.id],
    );
    assert.equal((await service.list("ctx-a"))[0]?.status, "delivered");
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
