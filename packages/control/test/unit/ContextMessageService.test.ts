import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { InstanceEventType, JsonValue } from "@portable-devshell/shared";

import { ContextMessageService } from "../../src/instance/context/ContextMessageService.ts";

test("ContextMessageService persists pending messages and marks only the matching context delivered", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-context-message-"));
    const events: Array<{ data: JsonValue; type: InstanceEventType }> = [];
    const options = {
        appendEvent: async (type: Extract<InstanceEventType, `context.message.${string}`>, data: JsonValue) => {
            events.push({ data, type });
        },
        filePath: join(root, "context-messages.json"),
        instanceName: "alpha"
    };
    const service = new ContextMessageService(options);

    const first = await service.queue({ ctxId: "ctx-a", text: "Check the latest failure" });
    const second = await service.queue({ ctxId: "ctx-b", text: "Keep this pending" });

    assert.equal(first.status, "pending");
    assert.deepEqual((await service.list()).map((message) => message.status), ["pending", "pending"]);
    assert.deepEqual(await service.readPending("ctx-missing"), { messages: [] });

    const delivered = await service.readPending("ctx-a");
    assert.deepEqual(delivered.messages.map((message) => message.text), ["Check the latest failure"]);
    assert.deepEqual(
        (await service.list()).map((message) => [message.id, message.status]),
        [[first.id, "delivered"], [second.id, "pending"]]
    );

    const reloaded = new ContextMessageService(options);
    assert.deepEqual(
        (await reloaded.list()).map((message) => [message.id, message.status]),
        [[first.id, "delivered"], [second.id, "pending"]]
    );
    assert.deepEqual(events.map((event) => event.type), [
        "context.message.queued",
        "context.message.queued",
        "context.message.delivered"
    ]);
});

test("ContextMessageService marks a queued message failed when its audit event cannot be recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-context-message-failure-"));
    const service = new ContextMessageService({
        appendEvent: async (type) => {
            if (type === "context.message.queued") throw new Error("audit unavailable");
        },
        filePath: join(root, "context-messages.json"),
        instanceName: "alpha"
    });

    await assert.rejects(
        service.queue({ ctxId: "ctx-a", text: "Do not lose this message" }),
        /audit unavailable/u
    );
    const [record] = await service.list("ctx-a");
    assert.equal(record?.status, "failed");
    assert.equal(record?.error, "audit unavailable");
});
