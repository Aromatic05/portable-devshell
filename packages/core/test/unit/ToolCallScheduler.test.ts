import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName, errorCodes } from "@portable-devshell/shared";
import { ToolCallScheduler } from "@portable-devshell/core";

test("ToolCallScheduler runs up to the configured limit and keeps later calls queued", async () => {
    const instanceName = asInstanceName("scheduler-test");
    const scheduler = new ToolCallScheduler({
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
                sessionId: "session-1",
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

test("ToolCallScheduler rejects requests that exceed the bounded queue", () => {
    const instanceName = asInstanceName("scheduler-test");
    const scheduler = new ToolCallScheduler({
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
