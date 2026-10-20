import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createRemoteError, runtimeErrorCodes, type RemoteErrorBody } from "@portable-devshell/shared";
import { createAuditRuntime } from "../../../src/audit/index.ts";
import { barrier, round4Target } from "./Round4Harness.ts";
import { durableCalls } from "./Round6AuditFixture.ts";

for (const code of ["tool.cancelled", runtimeErrorCodes.toolCallCancelled, runtimeErrorCodes.toolQueueTimeout]) {
    for (const retryable of [false, true]) {
        test(`completed execution survives adapter ${code} (retryable=${retryable}) without a safe retry`, async (t) => {
            const h = await round4Target();
            t.after(() => h.close());
            const path = join(h.directory, "completed-effect");
            let effects = 0;
            let adaptedCallId = "";
            h.runtime.hooks.registerExecute("local_effect", async () => {
                await appendFile(path, "committed\n");
                effects++;
                return { private: "raw output" };
            });

            await assert.rejects(h.runtime.api.call("round4", "local_effect", { input: "original" }, {
                source: "cli", ctxId: "adapter-context", requestId: "adapter-request",
            }, undefined, async (_result, callId) => {
                adaptedCallId = callId;
                assert.equal(await readFile(path, "utf8"), "committed\n");
                throw createRemoteError({ code, message: "adapter cancelled", retryable, details: { adapter: "result" } });
            }), (error: unknown) => {
                const failure = error as RemoteErrorBody;
                assert.equal(failure.retryable, false);
                assert.equal(failure.code, code === "tool.cancelled" ? runtimeErrorCodes.toolCallCancelled : code);
                assert.deepEqual(failure.details, {
                    adapter: "result", callId: adaptedCallId,
                    executionCompleted: true, failureStage: "postExecution",
                });
                return true;
            });

            assert.equal(effects, 1);
            assert.equal(await readFile(path, "utf8"), "committed\n");
            const reader = createAuditRuntime({ instanceName: h.instanceName, filePath: h.databasePath, eventBufferSize: 100 });
            let records;
            let events;
            try {
                records = reader.api.toolCalls.readQuery();
                events = reader.api.events.readFrom(0);
            } finally {
                await reader.close();
            }
            assert.equal(records.length, 1);
            const record = records[0]!;
            assert.equal(record.callId, adaptedCallId);
            assert.equal(record.status, "failed");
            assert.equal(record.error, code === "tool.cancelled" ? runtimeErrorCodes.toolCallCancelled : code);
            assert.equal(record.executionCompleted, true);
            assert.equal(record.failureStage, "postExecution");
            assert.equal(record.ctxId, "adapter-context");
            assert.equal(record.requestId, "adapter-request");
            assert.deepEqual(record.input, { input: "original" });
            assert.equal(record.output, undefined);
            const terminal = events.filter((event) =>
                ["toolCall.failed", "toolCall.cancelled", "toolCall.queueTimeout"].includes(event.type));
            assert.equal(terminal.length, 1);
            assert.equal(terminal[0]!.type, "toolCall.failed");
            assert.equal((terminal[0]!.data as Record<string, unknown>).executionCompleted, true);
            assert.equal((terminal[0]!.data as Record<string, unknown>).failureStage, "postExecution");
            assert.equal(h.history.hasActiveForContext("adapter-context"), false);
        });
    }
}

test("native caller abort during adaptation retains completed execution and postExecution audit", async (t) => {
    const h = await round4Target();
    t.after(() => h.close());
    const controller = new AbortController();
    let effects = 0;
    let adaptedCallId = "";
    h.runtime.hooks.registerExecute("local_effect", async () => ({ effect: ++effects }));
    await assert.rejects(h.runtime.api.call("round4", "local_effect", {}, { source: "cli" },
        controller.signal, async (_result, callId) => {
            adaptedCallId = callId;
            controller.abort();
            controller.signal.throwIfAborted();
            return null;
        }), (error: unknown) => {
        const failure = error as RemoteErrorBody;
        assert.equal(failure.code, runtimeErrorCodes.toolCallCancelled);
        assert.equal(failure.retryable, false);
        assert.deepEqual(failure.details, { callId: adaptedCallId, executionCompleted: true, failureStage: "postExecution" });
        return true;
    });
    assert.equal(effects, 1);
    const [record] = await durableCalls(h);
    assert.equal(record?.status, "failed");
    assert.equal(record?.callId, adaptedCallId);
    assert.equal(record?.error, runtimeErrorCodes.toolCallCancelled);
    assert.equal(record?.executionCompleted, true);
    assert.equal(record?.failureStage, "postExecution");
});

for (const code of ["tool.cancelled", runtimeErrorCodes.toolCallCancelled]) {
    test(`running executor ${code} after an effect retains cancelled audit without a safe retry`, async (t) => {
        const h = await round4Target();
        t.after(() => h.close());
        let effects = 0;
        let executedCallId = "";
        h.runtime.hooks.registerExecute("local_effect", async (callId) => {
            executedCallId = callId;
            effects++;
            throw createRemoteError({ code, message: "executor cancelled", retryable: true });
        });
        await assert.rejects(h.runtime.api.call("round4", "local_effect", {}, { source: "cli" }), (error: unknown) => {
            const failure = error as RemoteErrorBody;
            assert.equal(failure.retryable, false);
            assert.equal(failure.code, runtimeErrorCodes.toolCallCancelled);
            assert.deepEqual(failure.details, { callId: executedCallId, executionCompleted: false });
            return true;
        });
        assert.equal(effects, 1);
        const [record] = await durableCalls(h);
        assert.equal(record?.status, "cancelled");
        assert.equal(record?.error, runtimeErrorCodes.toolCallCancelled);
        assert.equal(record?.callId, executedCallId);
    });
}

for (const outcome of ["cancelled", "queueTimeout"] as const) {
    test(`never-started ${outcome} remains retryable through real scheduler and SQLite audit`, async (t) => {
        const h = await round4Target({ maxRunning: 1, maxRunningPerSession: 1, queueTimeoutMs: 1000 });
        const entered = barrier();
        const release = barrier();
        t.after(async () => { release.resolve(); await h.close(); });
        let blockedEffects = 0;
        let queuedEffects = 0;
        h.runtime.hooks.registerExecute("blocker", async () => {
            blockedEffects++;
            entered.resolve();
            await release.promise;
            return { ok: true };
        });
        h.runtime.hooks.registerExecute("queued_effect", async () => ({ effect: ++queuedEffects }));
        const blocker = h.runtime.api.call("round4", "blocker", {}, { source: "cli" });
        await entered.promise;
        const queued = barrier();
        const reserve = h.scheduler.reserve.bind(h.scheduler);
        t.mock.method(h.scheduler, "reserve", (...args: Parameters<typeof reserve>) => {
            const reservation = reserve(...args);
            return {
                release: reservation.release,
                run<T>(work: () => Promise<T>) {
                    const result = reservation.run(work);
                    queued.resolve();
                    return result;
                },
            };
        });
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const controller = new AbortController();
        const pending = h.runtime.api.call("round4", "queued_effect", {},
            { source: "cli", ctxId: "queued-context" }, controller.signal);
        const rejected = assert.rejects(pending, (error: unknown) => {
            const failure = error as RemoteErrorBody;
            assert.equal(failure.code, outcome === "cancelled"
                ? runtimeErrorCodes.toolCallCancelled : runtimeErrorCodes.toolQueueTimeout);
            assert.equal(failure.retryable, true);
            assert.equal((failure.details as Record<string, unknown>).executionCompleted, undefined);
            return true;
        });
        await queued.promise;
        const settle = {
            cancelled: () => controller.abort(new Error("queue caller left")),
            queueTimeout: () => t.mock.timers.tick(1000),
        };
        settle[outcome]();
        await rejected;
        assert.equal(queuedEffects, 0);
        const records = await durableCalls(h);
        assert.equal(records.length, 1);
        assert.equal(records[0]!.status, outcome);
        assert.equal(records[0]!.executionCompleted, undefined);
        assert.equal(records[0]!.failureStage, undefined);
        assert.equal(h.history.hasActiveForContext("queued-context"), false);
        release.resolve();
        assert.deepEqual(await blocker, { ok: true });
        assert.equal(blockedEffects, 1);
        assert.deepEqual(await h.runtime.api.call("round4", "queued_effect", {}, { source: "cli" }), { effect: 1 });
        assert.equal(queuedEffects, 1);
    });
}
