import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createRemoteError } from "@portable-devshell/shared";
import { round4Target } from "../../packages/core/test/unit/tool/Round4Harness.ts";
import { durableCalls } from "../../packages/core/test/unit/tool/Round6AuditFixture.ts";
const options = { timeout: 10_000 };

test("round6: asynchronous result adaptation failure durably attributes an already committed effect", options, async (t) => {
    const h = await round4Target(); t.after(() => h.close());
    const path = join(h.directory, "adaptation-effect");
    h.runtime.hooks.registerExecute("local_effect", async () => {
        await appendFile(path, "committed\n"); return { private: "raw output" };
    });
    let adaptedCallId = ""; let retryable: boolean | undefined;
    await assert.rejects(h.runtime.api.call("round4", "local_effect", { token: "original" }, {
        source: "extension", extensionId: "round6.extension", ctxId: "adapter-context",
        requestId: "adapter-request", workspace: h.directory,
    }, undefined, async (_value, callId) => {
        adaptedCallId = callId;
        await readFile(path, "utf8");
        throw createRemoteError({ code: "round6.adapter", message: "adapter unavailable", retryable: true });
    }), (error: unknown) => {
        const failure = error as { code: string; retryable: boolean; details: { executionCompleted: boolean; failureStage: string } };
        assert.equal(failure.code, "round6.adapter"); retryable = failure.retryable;
        assert.equal(failure.details.executionCompleted, true); assert.equal(failure.details.failureStage, "postExecution");
        return true;
    });
    const records = await durableCalls(h); assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.callId, adaptedCallId); assert.equal(record.status, "failed");
    assert.equal(record.executionCompleted, true); assert.equal(record.failureStage, "postExecution");
    assert.equal(record.error, "round6.adapter"); assert.equal(record.output, undefined);
    assert.equal(record.extensionId, "round6.extension"); assert.equal(record.requestId, "adapter-request");
    assert.equal(record.ctxId, "adapter-context"); assert.equal(record.workspace, h.directory);
    assert.deepEqual(record.input, { token: "original" });
    assert.equal(await readFile(path, "utf8"), "committed\n");
    assert.equal(h.history.hasActiveForContext("adapter-context"), false);
    t.diagnostic(JSON.stringify({ sideEffect: await readFile(path, "utf8"), record, retryable }));
    assert.equal(retryable, false);
});
