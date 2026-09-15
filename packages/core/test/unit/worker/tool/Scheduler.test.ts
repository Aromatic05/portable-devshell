import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName, errorCodes } from "@portable-devshell/shared";
import { WorkerToolCallScheduler } from "@portable-devshell/core/testing";

test("WorkerToolCallScheduler runs up to the configured limit and keeps later calls queued", async () => {
    const instanceName = asInstanceName("scheduler-test");
    const scheduler = new WorkerToolCallScheduler({
        byTool: {},
        maxRunning: 2,
        maxRunningPerSession: 2,
        queueDepth: 2,
        queueDepthPerSession: 2,
        queueTimeoutMs: 1_000
    });
    const completions = [createDeferred<string>(), createDeferred<string>(), createDeferred<string>()];
    const started: string[] = [];
    const calls = [0, 1, 2].map((index) =>
        scheduler
            .reserve({
                callId: `call-${index}`,
                instanceName,
                ctxId: "context-1",
                source: "mcp",
                toolName: "bash_run"
            })
            .run(async () => {
                started.push(`call-${index}`);
                return await completions[index]!.promise;
            })
    );

    await waitFor(() => started.length === 2);
    assert.deepEqual(started, ["call-0", "call-1"]);

    completions[0]!.resolve("first");
    assert.equal(await calls[0], "first");
    await waitFor(() => started.length === 3);
    assert.deepEqual(started, ["call-0", "call-1", "call-2"]);

    completions[1]!.resolve("second");
    completions[2]!.resolve("third");
    assert.deepEqual(await Promise.all(calls.slice(1)), ["second", "third"]);
});

test("WorkerToolCallScheduler rejects requests that exceed the bounded queue", () => {
    const instanceName = asInstanceName("scheduler-test");
    const scheduler = new WorkerToolCallScheduler({
        byTool: {},
        maxRunning: 1,
        maxRunningPerSession: 10,
        queueDepth: 1,
        queueDepthPerSession: 10,
        queueTimeoutMs: 1_000
    });

    scheduler.reserve({ callId: "running", instanceName, source: "mcp", toolName: "bash_run" });
    scheduler.reserve({ callId: "queued", instanceName, source: "mcp", toolName: "bash_run" });

    assert.throws(
        () => scheduler.reserve({ callId: "rejected", instanceName, source: "mcp", toolName: "bash_run" }),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreToolSchedulerFull);
            assert.deepEqual((error as { details?: { fullReasons?: string[] } }).details?.fullReasons, ["instance", "tool"]);
            return true;
        }
    );
});

test("WorkerToolCallScheduler cancels a queued request when its abort signal fires", async () => {
    const instanceName = asInstanceName("scheduler-cancel");
    const scheduler = new WorkerToolCallScheduler({
        byTool: {},
        maxRunning: 1,
        maxRunningPerSession: 2,
        queueDepth: 2,
        queueDepthPerSession: 2,
        queueTimeoutMs: 1_000
    });
    const blocker = createDeferred<string>();
    const started: string[] = [];
    const running = scheduler
        .reserve({ callId: "running", instanceName, ctxId: "context-1", source: "mcp", toolName: "bash_run" })
        .run(async () => {
            started.push("running");
            return await blocker.promise;
        });
    await waitFor(() => started.length === 1);

    const controller = new AbortController();
    const queued = scheduler
        .reserve(
            { callId: "queued", instanceName, ctxId: "context-1", source: "mcp", toolName: "bash_run" },
            controller.signal
        )
        .run(async () => {
            started.push("queued");
            return "unexpected";
        });
    controller.abort("client cancelled");

    await assert.rejects(queued, (error: unknown) => {
        assert.equal((error as { code?: string }).code, errorCodes.coreToolCallCancelled);
        return true;
    });
    assert.deepEqual(started, ["running"]);
    blocker.resolve("done");
    assert.equal(await running, "done");
});

function createDeferred<T>(): { promise: Promise<T>; reject: (error: unknown) => void; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, reject, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (condition()) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 1));
    }

    throw new Error("condition was not reached");
}

test("WorkerToolCallScheduler admits one urgent tmux operation beyond normal instance and context limits", async () => {
    const instanceName = asInstanceName("scheduler-urgent");
    const scheduler = new WorkerToolCallScheduler({
        byTool: {},
        maxRunning: 2,
        maxRunningPerSession: 2,
        queueDepth: 2,
        queueDepthPerSession: 2,
        queueTimeoutMs: 1_000
    });
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    const urgent = createDeferred<string>();
    const started: string[] = [];

    const run = (callId: string, toolName: string, deferred: ReturnType<typeof createDeferred<string>>) =>
        scheduler
            .reserve({ callId, instanceName, ctxId: "context-1", source: "mcp", toolName })
            .run(async () => {
                started.push(callId);
                return await deferred.promise;
            });

    const firstCall = run("normal-1", "tmux_run", first);
    const secondCall = run("normal-2", "tmux_read", second);
    await waitFor(() => started.length === 2);

    const urgentCall = run("urgent", "tmux_input", urgent);
    await waitFor(() => started.includes("urgent"));
    assert.deepEqual(started, ["normal-1", "normal-2", "urgent"]);

    urgent.resolve("interrupted");
    first.resolve("first");
    second.resolve("second");
    assert.deepEqual(await Promise.all([firstCall, secondCall, urgentCall]), ["first", "second", "interrupted"]);
});

test("WorkerToolCallScheduler prioritizes queued urgent tmux operations", async () => {
    const instanceName = asInstanceName("scheduler-priority");
    const scheduler = new WorkerToolCallScheduler({
        byTool: {},
        maxRunning: 1,
        maxRunningPerSession: 10,
        queueDepth: 4,
        queueDepthPerSession: 10,
        queueTimeoutMs: 1_000
    });
    const blocker = createDeferred<string>();
    const normal = createDeferred<string>();
    const urgent = createDeferred<string>();
    const started: string[] = [];
    const reserve = (callId: string, toolName: string, deferred: ReturnType<typeof createDeferred<string>>) =>
        scheduler
            .reserve({ callId, instanceName, source: "mcp", toolName })
            .run(async () => {
                started.push(callId);
                return await deferred.promise;
            });

    const blockerCall = reserve("blocker", "bash_run", blocker);
    await waitFor(() => started.length === 1);
    const normalCall = reserve("normal", "tmux_read", normal);
    const urgentCall = reserve("urgent", "tmux_input", urgent);
    await waitFor(() => started.includes("urgent"));
    assert.deepEqual(started, ["blocker", "urgent"]);

    urgent.resolve("urgent");
    blocker.resolve("blocker");
    await blockerCall;
    await waitFor(() => started.includes("normal"));
    normal.resolve("normal");
    assert.deepEqual(await Promise.all([normalCall, urgentCall]), ["normal", "urgent"]);
});
