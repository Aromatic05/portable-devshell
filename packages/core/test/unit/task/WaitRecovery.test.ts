import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";

import { asInstanceName, createRemoteError } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { WaitService } from "../../../src/task/wait/index.ts";

const input = {
    callId: "call-1", ctxId: "ctx-1", instance: asInstanceName("local"),
    source: "mcp" as const, targetId: "task-1", toolName: "tmux_run",
};

async function until(check: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 180; attempt++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.fail("Wait never reached the expected durable state");
}

test("a successful terminal observation survives a transient rename failure without rereading the Worker", {
    timeout: 7_000,
}, async (t) => {
    const root = await createTestTempDirectory("wait-terminal-retry-");
    const filePath = join(root, "waits.json");
    const originalRename = fs.promises.rename;
    let renames = 0;
    t.mock.method(fs.promises, "rename", async (...args: Parameters<typeof fs.promises.rename>) => {
        if (++renames === 3)
            throw Object.assign(new Error("terminal commit failed"), { code: "EIO" });
        await originalRename(...args);
    });
    syncBuiltinESMExports();
    let reads = 0;
    const events: string[] = [];
    const service = new WaitService({
        filePath,
        appendEvent: async (type) => { events.push(type); },
        invoke: {
            async invoke() {
                reads += 1;
                if (reads === 1)
                    return { waitReason: "terminal", task: { id: "task-1", status: "exited", exitCode: 0 } };
                throw createRemoteError({
                    code: "tmux.taskExpired",
                    message: "Worker already collected the task",
                    retryable: false,
                });
            },
        },
    });
    t.after(async () => {
        await service.close();
        t.mock.restoreAll();
        syncBuiltinESMExports();
    });
    await service.detach(input);
    await until(async () => (await service.list())[0]?.status === "resolved");
    const record = (await service.list())[0]!;
    assert.equal(record.status, "resolved");
    assert.deepEqual(record.result, {
        waitReason: "terminal", task: { id: "task-1", status: "exited", exitCode: 0 },
    });
    assert.equal(reads, 1);
    assert.deepEqual(events, ["wait.detached", "wait.resolved"]);
    const restored = new WaitService({
        filePath, appendEvent: async () => undefined,
        invoke: { invoke: async () => null },
    });
    assert.equal((await restored.list())[0]?.status, "resolved");
    await restored.close();
});

test("a failed terminal notification is redelivered after Control restart, not discarded", async () => {
    const root = await createTestTempDirectory("wait-event-recovery-");
    const filePath = join(root, "waits.json");
    const before: string[] = [];
    const service = new WaitService({
        filePath,
        appendEvent: async (type) => {
            before.push(type);
            if (type === "wait.resolved") throw new Error("injected audit EIO");
        },
        invoke: {
            invoke: async () => ({
                task: { id: "task-1", status: "exited" }, waitReason: "terminal",
            }),
        },
    });
    await service.detach(input);
    await until(async () => (await service.list())[0]?.status === "resolved");
    await service.close();
    assert.deepEqual(before, ["wait.detached", "wait.resolved"]);
    const persisted = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    assert.deepEqual(persisted.notifications.map((item: { type: string }) => item.type), ["wait.resolved"]);

    const delivered: string[] = [];
    let rereads = 0;
    const restarted = new WaitService({
        filePath,
        appendEvent: async (type) => { delivered.push(type); },
        invoke: { invoke: async () => { rereads++; return null; } },
    });
    restarted.resume();
    await until(async () => delivered.includes("wait.resolved"));
    await restarted.close();
    assert.equal(rereads, 0, "a completed Wait must not be monitored again");
    assert.deepEqual(delivered, ["wait.resolved"]);
    const acknowledged = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    assert.deepEqual(acknowledged.notifications, []);
});

test("transient notification errors retry delivery within a running Control", { timeout: 4_000 }, async () => {
    const root = await createTestTempDirectory("wait-event-live-");
    const events: string[] = [];
    let failures = 1;
    const service = new WaitService({
        filePath: join(root, "waits.json"),
        appendEvent: async (type) => {
            if (type === "wait.detached" && failures-- > 0)
                throw new Error("injected event EIO");
            events.push(type);
        },
        invoke: {
            invoke: async (_name, _payload, _context, signal) =>
                await new Promise((resolve) =>
                    signal?.addEventListener("abort", () => resolve(null), { once: true })),
        },
    });
    try {
        await service.detach(input);
        await until(async () => events.includes("wait.detached"));
        assert.deepEqual(events, ["wait.detached"]);
    } finally {
        await service.close();
    }
});
