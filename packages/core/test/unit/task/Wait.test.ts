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
import type { ToolCallHooks } from "../../../src/toolcall/Api.ts";
import {
    WAIT_HANDOFF_MS,
    WAIT_SYNC_MS,
    WaitService,
} from "../../../src/task/wait/index.ts";
import { installWaitToolCallRewrite } from "../../../src/task/wait/Runtime.ts";

test("Wait rewrite clamps bash_run/task_input and detaches timed-out tasks", async () => {
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
    const contributors: Array<
        Parameters<ToolCallHooks["registerContributor"]>[0]
    > = [];
    const hooks: ToolCallHooks = {
        registerContributor(contributor) {
            contributors.push(contributor);
            return () => {
                const index = contributors.indexOf(contributor);
                if (index >= 0) contributors.splice(index, 1);
            };
        },
        registerExecute() {
            return () => undefined;
        },
        registerReview() {
            return () => undefined;
        },
    };
    const uninstall = installWaitToolCallRewrite(hooks, wait);
    const context = {
        ctxId: "ctx-1",
        instance: instanceName,
        source: "mcp" as const,
        workspace: "/repo",
    };
    const signal = new AbortController().signal;
    const contribution = await contributors[0]!(context, {
        recording: "host",
        signal,
    });
    assert.ok(contribution.rewrites);
    const rewrite = contribution.rewrites[0]!.rewrite;
    const runtime = { recording: "host" as const, signal };
    try {
        const run = await rewrite({
            callId: "call-run",
            direction: "inbound",
            value: {
                context,
                kind: "call",
                payload: { waitMs: 250_000 },
                toolName: "bash_run",
            },
        }, runtime);
        assert.equal((run.payload as Record<string, JsonValue>).waitMs, WAIT_HANDOFF_MS);

        const handedOff = await rewrite({
            callId: "call-run",
            direction: "outbound",
            value: {
                context,
                kind: "result",
                payload: {
                    task: { id: "task-1", status: "running" },
                    termination: "running",
                    waitReason: "timeout",
                    waitMs: WAIT_HANDOFF_MS,
                },
                toolName: "bash_run",
            },
        }, runtime);
        assert.equal((handedOff.payload as Record<string, JsonValue>).detached, true);
        assert.equal((handedOff.payload as Record<string, JsonValue>).timedOut, undefined);
        assert.deepEqual(detached, [
            {
                callId: "call-run",
                ctxId: "ctx-1",
                instance: instanceName,
                source: "mcp",
                targetId: "task-1",
                toolName: "bash_run",
                workspace: "/repo",
            },
        ]);

        await rewrite({
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
                toolName: "bash_run",
            },
        }, runtime);
        assert.equal(detached.length, 1);

        const shortDeadline = await rewrite({
            callId: "call-short",
            direction: "outbound",
            value: {
                context,
                kind: "result",
                payload: { task: { id: "task-short", status: "running" }, waitMs: 300, waitReason: "timeout", termination: "running" },
                toolName: "bash_run",
            },
        }, runtime);
        assert.equal((shortDeadline.payload as Record<string, JsonValue>).termination, "running");
        assert.equal((shortDeadline.payload as Record<string, JsonValue>).detached, undefined);

        const stateless = await rewrite({
            callId: "call-stateless",
            direction: "outbound",
            value: {
                context: {
                    instance: instanceName,
                    contextMode: "stateless",
                    ctxId: "57a7e1e5-5000-8000-8000-000000000000",
                    source: "mcp",
                },
                kind: "result",
                payload: { task: { id: "stateless-task", status: "running" }, waitMs: 300, waitReason: "timeout", termination: "running" },
                toolName: "bash_run",
            },
        }, runtime);
        assert.equal((stateless.payload as Record<string, JsonValue>).termination, "running");
        assert.equal((stateless.payload as Record<string, JsonValue>).detached, undefined);
        assert.equal(detached.length, 1);

        const read = await rewrite({
            callId: "call-read",
            direction: "inbound",
            value: {
                context,
                kind: "call",
                payload: { task: "task-3", waitMs: 300_000 },
                toolName: "task_input",
            },
        }, runtime);
        assert.equal((read.payload as Record<string, JsonValue>).waitMs, WAIT_SYNC_MS);

        const shortTaskInput = await rewrite({
            callId: "call-input-short",
            direction: "outbound",
            value: {
                context,
                kind: "result",
                payload: {
                    task: { id: "task-3", status: "running", pty: false },
                    termination: "running",
                    waitReason: "timeout",
                    waitMs: 5_000,
                    untilExit: true,
                },
                toolName: "task_input",
            },
        }, runtime);
        assert.equal((shortTaskInput.payload as Record<string, JsonValue>).detached, undefined);
        assert.equal(detached.length, 1);

        const interactiveTaskInput = await rewrite({
            callId: "call-input-interactive",
            direction: "outbound",
            value: {
                context,
                kind: "result",
                payload: {
                    task: { id: "task-3", status: "running", pty: true },
                    termination: "running",
                    waitReason: "timeout",
                    waitMs: WAIT_SYNC_MS,
                    untilExit: false,
                },
                toolName: "task_input",
            },
        }, runtime);
        assert.equal((interactiveTaskInput.payload as Record<string, JsonValue>).detached, undefined);
        assert.equal(detached.length, 1);

        const longTaskInput = await rewrite({
            callId: "call-input-long",
            direction: "outbound",
            value: {
                context,
                kind: "result",
                payload: {
                    task: { id: "task-3", status: "running", pty: false },
                    termination: "running",
                    waitReason: "timeout",
                    waitMs: WAIT_SYNC_MS,
                    untilExit: true,
                },
                toolName: "task_input",
            },
        }, runtime);
        assert.equal((longTaskInput.payload as Record<string, JsonValue>).detached, true);
        assert.equal(detached.length, 2);
        assert.deepEqual(detached[1], {
            callId: "call-input-long",
            ctxId: "ctx-1",
            instance: instanceName,
            source: "mcp",
            targetId: "task-3",
            toolName: "task_input",
            workspace: "/repo",
        });
    } finally {
        contribution.release();
        uninstall();
    }
});

test("WaitService persists detached task and resolves it through native task_input", async () => {
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
        toolName: "bash_run",
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
    assert.equal(calls[0]?.toolName, "task_input");
    assert.deepEqual(calls[0]?.input, {
        untilExit: true,
        task: "task-1",
        waitMs: WAIT_SYNC_MS,
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

test("WaitService.#monitor repeats full untilExit polls with WAIT_SYNC_MS until terminal", async (t) => {
    const root = await createTestTempDirectory("wait-cursor");
    const filePath = join(root, "waits.json");
    const calls: Array<{ toolName: string; input: JsonValue }> = [];
    const responses: JsonValue[] = [
        {
            task: { id: "task-cursor", status: "running", pty: false },
            cursor: "tc1_step1",
            waitReason: "timeout",
            waitMs: WAIT_SYNC_MS,
            termination: "running",
        },
        {
            task: { id: "task-cursor", status: "running", pty: false },
            cursor: "tc1_step2",
            waitReason: "timeout",
            waitMs: WAIT_SYNC_MS,
            termination: "running",
        },
        {
            task: { id: "task-cursor", status: "exited", pty: false },
            cursor: "tc1_done",
            waitReason: "terminal",
            termination: "exited",
        },
    ];
    let resolved!: () => void;
    const done = new Promise<void>((resolve) => { resolved = resolve; });
    const service = new WaitService({
        appendEvent: async (type) => {
            if (type === "wait.resolved") resolved();
        },
        filePath,
        invoke: {
            async invoke(toolName, input) {
                calls.push({ toolName, input });
                return responses[calls.length - 1]!;
            },
        },
        waitId: () => "wait-cursor",
    });
    t.after(() => service.close());

    await service.detach({
        callId: "call-cursor",
        ctxId: "ctx-cursor",
        instance: asInstanceName("local"),
        source: "mcp",
        targetId: "task-cursor",
        toolName: "bash_run",
        workspace: "/repo",
    });
    await done;

    assert.equal(calls.length, 3);
    assert.deepEqual(calls, [
        {
            toolName: "task_input",
            input: {
                untilExit: true,
                task: "task-cursor",
                waitMs: WAIT_SYNC_MS,
            },
        },
        {
            toolName: "task_input",
            input: {
                untilExit: true,
                task: "task-cursor",
                waitMs: WAIT_SYNC_MS,
            },
        },
        {
            toolName: "task_input",
            input: {
                untilExit: true,
                task: "task-cursor",
                waitMs: WAIT_SYNC_MS,
            },
        },
    ]);
    assert.equal((await service.list("ctx-cursor"))[0]?.status, "resolved");
});

test("Wait recovery keeps same-target Contexts isolated and resumes each monitor once", { timeout: 5_000 }, async (t) => {
    const root = await createTestTempDirectory("wait-context-recovery");
    const filePath = join(root, "waits.json");
    const monitored: string[] = [];
    const aborted: string[] = [];
    let ids = 0;
    const service = new WaitService({
        filePath,
        appendEvent: async () => undefined,
        waitId: () => `wait-${++ids}`,
        invoke: {
            async invoke(_tool, _input, context, signal) {
                const ctxId = context.ctxId!;
                monitored.push(ctxId);
                assert.ok(signal);
                return await new Promise<JsonValue>((_resolve, reject) => {
                    signal.addEventListener("abort", () => {
                        aborted.push(ctxId);
                        reject(new Error("monitor stopped"));
                    }, { once: true });
                });
            },
        },
    });
    t.after(() => service.close());
    const input = {
        callId: "call-a", ctxId: "ctx-a", instance: asInstanceName("local"),
        source: "mcp" as const, targetId: "same-task", toolName: "bash_run", workspace: "/shared",
    };
    const first = await service.detach(input);
    const duplicate = await service.detach({ ...input, callId: "call-a-retry" });
    const second = await service.detach({ ...input, ctxId: "ctx-b", callId: "call-b" });
    assert.equal(duplicate.waitId, first.waitId);
    assert.notEqual(second.waitId, first.waitId);
    assert.deepEqual(monitored, ["ctx-a", "ctx-b"]);
    assert.deepEqual((await service.list("ctx-a")).map(({ waitId }) => waitId), [first.waitId]);
    assert.deepEqual(await service.list("ctx-empty"), []);
    await service.close();
    assert.deepEqual(aborted.sort(), ["ctx-a", "ctx-b"]);
    assert.deepEqual((await service.list()).map(({ status }) => status), ["detached", "detached"]);
    await assert.rejects(service.detach(input), /closed/u);

    const resumed: string[] = [];
    const resolved: string[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const restored = new WaitService({
        filePath,
        appendEvent: async (type, data) => {
            assert.equal(type, "wait.resolved");
            resolved.push((data as { ctxId: string }).ctxId);
            if (resolved.length === 2) finish();
        },
        invoke: {
            async invoke(tool, payload, context) {
                assert.equal(tool, "task_input");
                assert.equal(context.workspace, "/shared");
                assert.deepEqual(payload, { untilExit: true, task: "same-task", waitMs: WAIT_SYNC_MS });
                resumed.push(context.ctxId!);
                return { waitReason: "terminal", task: { id: "same-task", status: "exited" } };
            },
        },
    });
    t.after(() => restored.close());
    assert.deepEqual(resumed, [], "recovery waits for an explicit resume");
    restored.resume();
    restored.resume();
    await finished;
    await restored.close();
    assert.deepEqual(resumed.sort(), ["ctx-a", "ctx-b"]);
    assert.deepEqual(resolved.sort(), ["ctx-a", "ctx-b"]);
    assert.equal((await restored.list("ctx-a"))[0]?.status, "resolved");
    assert.equal((await restored.list("ctx-b"))[0]?.status, "resolved");
});
