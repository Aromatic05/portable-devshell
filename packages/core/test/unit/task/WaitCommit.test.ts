import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { asInstanceName, type JsonValue } from "@portable-devshell/shared";

import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { WAIT_HANDOFF_MS, WAIT_SYNC_MS, WaitService } from "../../../src/task/wait/index.ts";
import { installWaitToolCallRewrite } from "../../../src/task/wait/Runtime.ts";
import { round4Target } from "../tool/Round4Harness.ts";

const eio = () => Object.assign(new Error("injected EIO"), { code: "EIO" });
const input = {
    callId: "call-a",
    ctxId: "ctx-a",
    instance: asInstanceName("local"),
    source: "mcp" as const,
    targetId: "task-a",
    toolName: "bash_run",
    workspace: "/repo",
};

async function fixture(t: TestContext, appendEvent: (type: string) => Promise<void> = async () => undefined) {
    const root = await createTestTempDirectory("wait-commit-");
    const filePath = join(root, "waits.json");
    const monitored: string[] = [];
    const service = new WaitService({
        filePath,
        appendEvent,
        invoke: {
            async invoke(_tool, payload, _context, signal) {
                monitored.push((payload as { task: string }).task);
                return await new Promise<JsonValue>((resolve) =>
                    signal?.addEventListener("abort", () => resolve({ waitReason: "timeout" }), { once: true }));
            },
        },
    });
    t.after(async () => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        await service.close();
    });
    return { root, filePath, monitored, service };
}

test("a failed Wait rename does not publish a phantom detached record", async (t) => {
    const f = await fixture(t);
    t.mock.method(fs.promises, "rename", async () => { throw eio(); });
    syncBuiltinESMExports();
    await assert.rejects(f.service.detach(input), { code: "EIO" });
    assert.deepEqual(await f.service.list(), []);
    assert.deepEqual(f.monitored, []);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await f.service.detach(input);
    assert.deepEqual(f.monitored, ["task-a"]);
    assert.equal((await new WaitService({
        filePath: f.filePath, appendEvent: async () => undefined,
        invoke: { invoke: async () => null },
    }).list()).length, 1);
});

test("a started bash task remains recoverable when Wait registration fails", async (t) => {
    const events: string[] = [];
    const f = await fixture(t, async (type) => { events.push(type); });
    const target = await round4Target();
    t.after(() => target.close());
    installWaitToolCallRewrite(target.runtime.hooks, f.service);

    const steps: string[] = [];
    const running = {
        task: { id: "task-started", status: "running", pty: false },
        cursor: "tc2_started",
        stdout: "started\n",
        stderr: "",
        termination: "running",
        waitReason: "timeout",
        waitMs: WAIT_HANDOFF_MS,
    };
    target.runtime.hooks.registerExecute("bash_run", async () => {
        steps.push("started");
        return running;
    });
    t.mock.method(fs.promises, "rename", async (...args: Parameters<typeof fs.promises.rename>) => {
        const to = args[1];
        steps.push(`register:${String(to)}`);
        throw eio();
    });
    syncBuiltinESMExports();

    const result = await target.runtime.api.call(
        target.instanceName, "bash_run", { command: "long-running", waitMs: WAIT_HANDOFF_MS },
        { source: "mcp", ctxId: "ctx-a" },
    );
    const expected = {
        ...running,
        waitError: {
            code: "wait.registrationFailed",
            message: "Durable Wait registration was not confirmed. Continue with task_input using the returned task ID and cursor; do not repeat the original call.",
        },
    };
    assert.deepEqual(result, expected);
    assert.deepEqual(steps, ["started", `register:${f.filePath}`]);
    assert.deepEqual(await f.service.list(), []);
    assert.deepEqual(f.monitored, []);
    assert.deepEqual(events, []);

    t.mock.restoreAll();
    syncBuiltinESMExports();
    const observation = { ...running, cursor: "tc2_observed", waitMs: WAIT_SYNC_MS, untilExit: true };
    target.runtime.hooks.registerExecute("task_input", async (_callId, input) => {
        assert.deepEqual(input, { task: running.task.id, cursor: running.cursor, waitMs: WAIT_SYNC_MS, untilExit: true });
        return observation;
    });
    assert.deepEqual(await target.runtime.api.call(
        target.instanceName, "task_input",
        { task: result.task.id, cursor: result.cursor, waitMs: WAIT_SYNC_MS, untilExit: true },
        { source: "mcp", ctxId: "ctx-a" },
    ), { ...observation, detached: true });
    assert.equal((await f.service.list())[0]?.targetId, running.task.id);
    assert.deepEqual(f.monitored, [running.task.id]);
    assert.deepEqual(events, ["wait.detached"]);
});

test("Wait monitors start even if event publication fails", async (t) => {
    const events: string[] = [];
    const f = await fixture(t, async (type) => { events.push(type); throw eio(); });
    await f.service.detach(input);
    assert.deepEqual(f.monitored, ["task-a"]);
    assert.deepEqual(events, ["wait.detached"]);
    assert.equal((await f.service.list())[0]?.status, "detached");
});

test("a committed rename that throws still starts the Wait monitor without retry duplication", async (t) => {
    const f = await fixture(t);
    const original = fs.promises.rename;
    t.mock.method(fs.promises, "rename", async (...args: Parameters<typeof fs.promises.rename>) => {
        await original(...args);
        throw eio();
    });
    syncBuiltinESMExports();
    await assert.rejects(f.service.detach(input), { code: "wait.commitDurabilityUnconfirmed", retryable: false });
    assert.deepEqual(f.monitored, ["task-a"]);
    const first = (await f.service.list())[0]!;
    assert.equal((await f.service.detach(input)).waitId, first.waitId);
    assert.deepEqual(f.monitored, ["task-a"]);
    assert.equal((await new WaitService({
        filePath: f.filePath, appendEvent: async () => undefined,
        invoke: { invoke: async () => null },
    }).list())[0]?.waitId, first.waitId);
});

test("Wait directory sync failure reports uncertainty but retains a usable monitor", {
    skip: process.platform === "win32",
}, async (t) => {
    const f = await fixture(t);
    const original = fs.promises.open;
    t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
        if (args[0] === f.root && args[1] === "r") throw eio();
        return await original(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.service.detach(input), { code: "wait.commitDurabilityUnconfirmed" });
    assert.deepEqual(f.monitored, ["task-a"]);
    assert.equal((await f.service.list())[0]?.targetId, "task-a");
});

test("unknown Wait rename blocks stale snapshots until disk is readable", async (t) => {
    const f = await fixture(t);
    const originalRename = fs.promises.rename;
    const originalRead = fs.readFileSync;
    let completed = false;
    t.mock.method(fs.promises, "rename", async (...args: Parameters<typeof fs.promises.rename>) => {
        await originalRename(...args);
        completed = true;
        throw eio();
    });
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        if (completed && args[0] === f.filePath) throw eio();
        return originalRead(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.service.detach(input), { code: "wait.commitUncertain", retryable: false });
    await assert.rejects(f.service.list(), { code: "EIO" });
    assert.deepEqual(f.monitored, []);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal((await f.service.list())[0]?.targetId, "task-a");
    assert.deepEqual(f.monitored, ["task-a"]);
});

test("concurrent detached Wait commits serialize without losing either record", async (t) => {
    const f = await fixture(t);
    const [a, b] = await Promise.all([
        f.service.detach(input),
        f.service.detach({ ...input, ctxId: "ctx-b", callId: "call-b" }),
    ]);
    assert.notEqual(a.waitId, b.waitId);
    assert.equal((await f.service.list()).length, 2);
    assert.equal((await new WaitService({
        filePath: f.filePath, appendEvent: async () => undefined,
        invoke: { invoke: async () => null },
    }).list()).length, 2);
});
