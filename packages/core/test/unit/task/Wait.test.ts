import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
    asInstanceName,
    type JsonValue,
    type WaitDetachInput,
} from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import type { WaitApi } from "../../../src/task/Api.ts";
import {
    WAIT_SYNC_MS,
    WaitService,
} from "../../../src/task/wait/index.ts";
import { installWaitToolCallRewrite } from "../../../src/task/wait/Runtime.ts";
import { ToolCallHookRegistry } from "../../../src/toolcall/registration/index.ts";

test("Wait rewrite clamps tmux block/read and detaches timed-out tasks", async () => {
    const detached: WaitDetachInput[] = [];
    const instanceName = asInstanceName("local");
    const wait = {
        async detach(input: WaitDetachInput) {
            detached.push(input);
            const now = "2026-10-04T00:00:00.000Z";
            return {
                ...input,
                createdAt: now,
                status: "detached" as const,
                updatedAt: now,
                waitId: `wait-${detached.length}`,
            };
        },
        async list() {
            return [];
        },
    } satisfies WaitApi;
    const hooks = new ToolCallHookRegistry();
    const uninstall = installWaitToolCallRewrite(hooks, () => wait);
    const context = {
        ctxId: "ctx-1",
        instance: instanceName,
        source: "mcp" as const,
        workspace: "/repo",
    };
    const lease = await hooks.provider()(
        context,
        new AbortController().signal,
        "host",
    );
    try {
        const run = await lease.sequence.rewrite({
            callId: "call-run",
            direction: "inbound",
            value: {
                context,
                kind: "call",
                payload: { timeMs: 250_000, wait: "block" },
                toolName: "tmux_run",
            },
        });
        assert.equal((run.payload as Record<string, JsonValue>).timeMs, WAIT_SYNC_MS);

        await lease.sequence.rewrite({
            callId: "call-run",
            direction: "outbound",
            value: {
                context,
                kind: "result",
                payload: {
                    task: { id: "task-1", status: "running" },
                    timedOut: true,
                },
                toolName: "tmux_run",
            },
        });
        assert.deepEqual(detached, [
            {
                callId: "call-run",
                ctxId: "ctx-1",
                instance: instanceName,
                source: "mcp",
                targetId: "task-1",
                toolName: "tmux_run",
                workspace: "/repo",
            },
        ]);

        await lease.sequence.rewrite({
            callId: "call-cancel",
            direction: "outbound",
            value: {
                context,
                kind: "error",
                payload: {
                    error: {
                        code: "tool.cancelled",
                        details: { task: "task-2" },
                        message: "cancelled",
                        retryable: false,
                    },
                },
                toolName: "tmux_run",
            },
        });
        assert.equal(detached[1]?.targetId, "task-2");

        const read = await lease.sequence.rewrite({
            callId: "call-read",
            direction: "inbound",
            value: {
                context,
                kind: "call",
                payload: { task: "task-3", timeMs: 300_000 },
                toolName: "tmux_read",
            },
        });
        assert.equal((read.payload as Record<string, JsonValue>).timeMs, WAIT_SYNC_MS);
    } finally {
        lease.release();
        uninstall();
    }
});

test("WaitService persists detached task and resolves it through native tmux_read", async () => {
    const instanceName = asInstanceName("local");
    const root = await createTestTempDirectory("wait-runtime");
    const filePath = join(root, "detached-waits.json");
    const events: string[] = [];
    const calls: Array<{ toolName: string; input: JsonValue }> = [];
    const service = new WaitService({
        appendEvent: async (type) => {
            events.push(type);
        },
        filePath,
        invoke: {
            async invoke(toolName, input) {
                calls.push({ toolName, input });
                return {
                    task: { id: "task-1", status: "exited" },
                    waitReason: "terminal",
                };
            },
        },
        now: (() => {
            let index = 0;
            const values = [
                "2026-10-04T00:00:00.000Z",
                "2026-10-04T00:01:00.000Z",
            ];
            return () => values[index++] ?? values.at(-1)!;
        })(),
        waitId: () => "wait-1",
    });
    await service.detach({
        callId: "call-1",
        ctxId: "ctx-1",
        instance: instanceName,
        source: "mcp",
        targetId: "task-1",
        toolName: "tmux_run",
        workspace: "/repo",
    });

    for (let index = 0; index < 50; index += 1) {
        const [record] = await service.list("ctx-1");
        if (record?.status === "resolved" && events.includes("wait.resolved")) break;
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const [record] = await service.list("ctx-1");
    assert.equal(record?.status, "resolved");
    assert.deepEqual(events, ["wait.detached", "wait.resolved"]);
    assert.equal(calls[0]?.toolName, "tmux_read");
    assert.deepEqual(calls[0]?.input, {
        consumeOutput: false,
        line: -1,
        task: "task-1",
        timeMs: WAIT_SYNC_MS,
    });

    const restored = new WaitService({
        appendEvent: async () => undefined,
        filePath,
        invoke: { async invoke() { throw new Error("unused"); } },
    });
    assert.equal((await restored.list("ctx-1"))[0]?.status, "resolved");
    await service.close();
    await restored.close();
});
