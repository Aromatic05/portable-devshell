import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName, runtimeErrorCodes, type JsonValue } from "@portable-devshell/shared";
import { classifyToolCall } from "../../../../src/toolcall/execution/ExecutionTarget.ts";
import {
    DEFAULT_MAX_OBSERVATIONS,
    WorkerToolCallScheduler,
} from "../../../../src/toolcall/execution/Scheduler.ts";

test("WorkerToolCallScheduler runs up to the configured limit and keeps later calls queued", async () => {
    const instanceName = asInstanceName("scheduler-test");
    const scheduler = new WorkerToolCallScheduler({
        byTool: {},
        maxRunning: 2,
        maxRunningPerSession: 2,
        queueDepth: 2,
        queueDepthPerSession: 2,
        queueTimeoutMs: 1_000,
    });
    const completions = [
        createDeferred<string>(),
        createDeferred<string>(),
        createDeferred<string>(),
    ];
    const started: string[] = [];
    const calls = [0, 1, 2].map((index) =>
        scheduler
            .reserve({
                callId: `call-${index}`,
                instanceName,
                ctxId: "context-1",
                source: "mcp",
                toolName: "bash_run",
            })
            .run(async () => {
                started.push(`call-${index}`);
                return await completions[index]!.promise;
            }),
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
        queueTimeoutMs: 1_000,
    });

    scheduler.reserve({
        callId: "running",
        instanceName,
        source: "mcp",
        toolName: "bash_run",
    });
    scheduler.reserve({
        callId: "queued",
        instanceName,
        source: "mcp",
        toolName: "bash_run",
    });

    assert.throws(
        () =>
            scheduler.reserve({
                callId: "rejected",
                instanceName,
                source: "mcp",
                toolName: "bash_run",
            }),
        (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                runtimeErrorCodes.toolSchedulerFull,
            );
            assert.deepEqual(
                (error as { details?: { fullReasons?: string[] } }).details
                    ?.fullReasons,
                ["instance", "tool"],
            );
            return true;
        },
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
        queueTimeoutMs: 1_000,
    });
    const blocker = createDeferred<string>();
    const started: string[] = [];
    const running = scheduler
        .reserve({
            callId: "running",
            instanceName,
            ctxId: "context-1",
            source: "mcp",
            toolName: "bash_run",
        })
        .run(async () => {
            started.push("running");
            return await blocker.promise;
        });
    await waitFor(() => started.length === 1);

    const controller = new AbortController();
    const queued = scheduler
        .reserve(
            {
                callId: "queued",
                instanceName,
                ctxId: "context-1",
                source: "mcp",
                toolName: "bash_run",
            },
            controller.signal,
        )
        .run(async () => {
            started.push("queued");
            return "unexpected";
        });
    controller.abort("client cancelled");

    await assert.rejects(queued, (error: unknown) => {
        assert.equal(
            (error as { code?: string }).code,
            runtimeErrorCodes.toolCallCancelled,
        );
        return true;
    });
    assert.deepEqual(started, ["running"]);
    blocker.resolve("done");
    assert.equal(await running, "done");
});

test("WorkerToolCallScheduler close cancels queued calls and waits for running calls", async () => {
    const instanceName = asInstanceName("scheduler-close");
    const scheduler = new WorkerToolCallScheduler({
        byTool: {},
        maxRunning: 1,
        maxRunningPerSession: 2,
        queueDepth: 2,
        queueDepthPerSession: 2,
        queueTimeoutMs: 1_000,
    });
    const started = createDeferred<void>();
    const completion = createDeferred<string>();
    const running = scheduler
        .reserve({
            callId: "running",
            instanceName,
            source: "mcp",
            toolName: "bash_run",
        })
        .run(async () => {
            started.resolve(undefined);
            return await completion.promise;
        });
    await started.promise;
    const queued = scheduler
        .reserve({
            callId: "queued",
            instanceName,
            source: "mcp",
            toolName: "bash_run",
        })
        .run(async () => "unexpected");

    let closed = false;
    const closing = scheduler.close().then(() => {
        closed = true;
    });
    await assert.rejects(queued, (error: unknown) => {
        assert.equal(
            (error as { code?: string }).code,
            runtimeErrorCodes.toolCallCancelled,
        );
        return true;
    });
    assert.equal(closed, false);
    assert.throws(() =>
        scheduler.reserve({
            callId: "after-close",
            instanceName,
            source: "mcp",
            toolName: "bash_run",
        }),
    );

    completion.resolve("finished");
    assert.equal(await running, "finished");
    await closing;
    assert.equal(closed, true);
});

function createDeferred<T>(): {
    promise: Promise<T>;
    reject: (error: unknown) => void;
    resolve: (value: T) => void;
} {
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

test("WorkerToolCallScheduler admits one urgent process operation beyond normal instance and context limits", async () => {
    const instanceName = asInstanceName("scheduler-urgent");
    const scheduler = new WorkerToolCallScheduler({
        byTool: {},
        maxRunning: 2,
        maxRunningPerSession: 2,
        queueDepth: 2,
        queueDepthPerSession: 2,
        queueTimeoutMs: 1_000,
    });
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    const urgent = createDeferred<string>();
    const started: string[] = [];

    const run = (
        callId: string,
        toolName: string,
        deferred: ReturnType<typeof createDeferred<string>>,
    ) =>
        scheduler
            .reserve({
                callId,
                instanceName,
                ctxId: "context-1",
                source: "mcp",
                toolName,
            })
            .run(async () => {
                started.push(callId);
                return await deferred.promise;
            });

    const firstCall = run("normal-1", "bash_run", first);
    const secondCall = run("normal-2", "file_read", second);
    await waitFor(() => started.length === 2);

    const urgentCall = run("urgent", "task_input", urgent);
    await waitFor(() => started.includes("urgent"));
    assert.deepEqual(started, ["normal-1", "normal-2", "urgent"]);

    urgent.resolve("interrupted");
    first.resolve("first");
    second.resolve("second");
    assert.deepEqual(await Promise.all([firstCall, secondCall, urgentCall]), [
        "first",
        "second",
        "interrupted",
    ]);
});

test("WorkerToolCallScheduler prioritizes queued urgent process operations", async () => {
    const instanceName = asInstanceName("scheduler-priority");
    const scheduler = new WorkerToolCallScheduler({
        byTool: {},
        maxRunning: 1,
        maxRunningPerSession: 10,
        queueDepth: 4,
        queueDepthPerSession: 10,
        queueTimeoutMs: 1_000,
    });
    const blocker = createDeferred<string>();
    const normal = createDeferred<string>();
    const urgent = createDeferred<string>();
    const started: string[] = [];
    const reserve = (
        callId: string,
        toolName: string,
        deferred: ReturnType<typeof createDeferred<string>>,
    ) =>
        scheduler
            .reserve({ callId, instanceName, source: "mcp", toolName })
            .run(async () => {
                started.push(callId);
                return await deferred.promise;
            });

    const blockerCall = reserve("blocker", "bash_run", blocker);
    await waitFor(() => started.length === 1);
    const normalCall = reserve("normal", "file_read", normal);
    const urgentCall = reserve("urgent", "task_input", urgent);
    await waitFor(() => started.includes("urgent"));
    assert.deepEqual(started, ["blocker", "urgent"]);

    urgent.resolve("urgent");
    blocker.resolve("blocker");
    await blockerCall;
    await waitFor(() => started.includes("normal"));
    normal.resolve("normal");
    assert.deepEqual(await Promise.all([normalCall, urgentCall]), [
        "normal",
        "urgent",
    ]);
});

test("classifyToolCall isolates long-running task_input reads as observations", () => {
    assert.equal(classifyToolCall("bash_run", { command: "sleep 1" }), "standard");
    assert.equal(classifyToolCall("task_manage", { task: "t-1", action: "close" }), "urgent");
    assert.equal(classifyToolCall("task_inspect", { task: "t-1" }), "urgent");

    assert.equal(
        classifyToolCall("task_input", { task: "t-1", untilExit: true, waitMs: 120_000 }),
        "observation",
    );
    assert.equal(
        classifyToolCall("task_input", { task: "t-1", untilExit: true, input: "" }),
        "observation",
    );
    assert.equal(
        classifyToolCall("task_input", { task: "t-1", input: null, waitMs: 30_000 }),
        "observation",
    );

    assert.equal(
        classifyToolCall("task_input", { task: "t-1", input: "hello\n", untilExit: true, waitMs: 60_000 }),
        "urgent",
    );
    assert.equal(
        classifyToolCall("task_input", { task: "t-1", untilExit: true, waitMs: 0 }),
        "urgent",
    );
    assert.equal(
        classifyToolCall("task_input", { task: "t-1", waitMs: 5_000 }),
        "urgent",
    );
    assert.equal(
        classifyToolCall("task_input", { task: "t-1" }),
        "urgent",
    );
});

test("WorkerToolCallScheduler observation polls do not starve task_manage(close) or task_input(input)", async () => {
    const instanceName = asInstanceName("scheduler-observation");
    const scheduler = new WorkerToolCallScheduler({
        byTool: {},
        maxRunning: 4,
        maxRunningPerSession: 2,
        queueDepth: 16,
        queueDepthPerSession: 4,
        queueTimeoutMs: 1_000,
    });
    const bash1 = createDeferred<string>();
    const bash2 = createDeferred<string>();
    const obs1 = createDeferred<string>();
    const obs2 = createDeferred<string>();
    const closeTask = createDeferred<string>();
    const writeInput = createDeferred<string>();
    const started: string[] = [];

    const launch = (
        callId: string,
        toolName: string,
        input: Record<string, JsonValue>,
        deferred: ReturnType<typeof createDeferred<string>>,
    ) =>
        scheduler
            .reserve({
                callId,
                instanceName,
                ctxId: "context-1",
                source: "mcp",
                toolName,
                toolCallClass: classifyToolCall(toolName, input),
            })
            .run(async () => {
                started.push(callId);
                return await deferred.promise;
            });

    const pBash1 = launch("bash-1", "bash_run", { command: "a" }, bash1);
    const pBash2 = launch("bash-2", "bash_run", { command: "b" }, bash2);
    const pObs1 = launch("obs-1", "task_input", { task: "t-1", untilExit: true, waitMs: 120_000 }, obs1);
    const pObs2 = launch("obs-2", "task_input", { task: "t-2", waitMs: 60_000 }, obs2);
    await waitFor(() => started.length === 4);

    // Even with 2 bash_run + 2 long-poll observations running in the same session,
    // urgent task_manage(close) starts immediately without waiting in queue.
    const pClose = launch("close-1", "task_manage", { task: "t-1", action: "close" }, closeTask);
    await waitFor(() => started.includes("close-1"));
    closeTask.resolve("closed");
    assert.equal(await pClose, "closed");

    // Interactive task_input(input) also starts immediately while observations remain active.
    const pWrite = launch("write-1", "task_input", { task: "t-2", input: "exit\n", waitMs: 60_000 }, writeInput);
    await waitFor(() => started.includes("write-1"));
    writeInput.resolve("written");
    assert.equal(await pWrite, "written");

    obs1.resolve("obs1-done");
    obs2.resolve("obs2-done");
    bash1.resolve("bash1-done");
    bash2.resolve("bash2-done");
    assert.deepEqual(await Promise.all([pBash1, pBash2, pObs1, pObs2]), [
        "bash1-done",
        "bash2-done",
        "obs1-done",
        "obs2-done",
    ]);
});

test("WorkerToolCallScheduler caps observation calls separately from standard and urgent limits", async () => {
    const instanceName = asInstanceName("scheduler-observation-cap");
    const scheduler = new WorkerToolCallScheduler();
    const obsDeferreds = Array.from({ length: DEFAULT_MAX_OBSERVATIONS }, () =>
        createDeferred<string>(),
    );
    const started: string[] = [];

    const obsCalls = obsDeferreds.map((deferred, index) =>
        scheduler
            .reserve({
                callId: `obs-${index}`,
                instanceName,
                ctxId: "context-1",
                source: "mcp",
                toolName: "task_input",
                toolCallClass: "observation",
            })
            .run(async () => {
                started.push(`obs-${index}`);
                return await deferred.promise;
            }),
    );
    await waitFor(() => started.length === DEFAULT_MAX_OBSERVATIONS);

    assert.throws(
        () =>
            scheduler.reserve({
                callId: "obs-overflow",
                instanceName,
                ctxId: "context-1",
                source: "mcp",
                toolName: "task_input",
                toolCallClass: "observation",
            }),
        (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                runtimeErrorCodes.toolSchedulerFull,
            );
            assert.deepEqual(
                (error as { details?: { fullReasons?: string[] } }).details?.fullReasons,
                ["observation"],
            );
            return true;
        },
    );

    const normal = createDeferred<string>();
    const urgent = createDeferred<string>();
    const pNormal = scheduler
        .reserve({
            callId: "normal-1",
            instanceName,
            ctxId: "context-1",
            source: "mcp",
            toolName: "bash_run",
            toolCallClass: "standard",
        })
        .run(async () => {
            started.push("normal-1");
            return await normal.promise;
        });
    const pUrgent = scheduler
        .reserve({
            callId: "urgent-1",
            instanceName,
            ctxId: "context-1",
            source: "mcp",
            toolName: "task_manage",
            toolCallClass: "urgent",
        })
        .run(async () => {
            started.push("urgent-1");
            return await urgent.promise;
        });
    await waitFor(() => started.includes("normal-1") && started.includes("urgent-1"));

    normal.resolve("ok-normal");
    urgent.resolve("ok-urgent");
    for (const d of obsDeferreds) d.resolve("ok-obs");
    assert.equal(await pNormal, "ok-normal");
    assert.equal(await pUrgent, "ok-urgent");
    await Promise.all(obsCalls);
});
