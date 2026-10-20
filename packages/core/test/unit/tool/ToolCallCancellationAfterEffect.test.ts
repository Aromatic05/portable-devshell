import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runtimeErrorCodes } from "@portable-devshell/shared";
import { barrier, round4Target } from "./Round4Harness.ts";
import { durableCalls } from "./Round6AuditFixture.ts";

test("running client cancellation records cancelled but does not advertise a safe retry after a side effect", async (t) => {
    const h = await round4Target();
    t.after(() => h.close());
    const path = join(h.directory, "cancelled-effect");
    const entered = barrier();
    const release = barrier();
    h.runtime.hooks.registerExecute("local_effect", async (_id, _input, _value, signal) => {
        await appendFile(path, "committed\n");
        entered.resolve();
        await release.promise;
        signal?.throwIfAborted();
        return { ok: true };
    });
    const controller = new AbortController();
    const pending = h.runtime.api.call(
        "round4", "local_effect", {},
        { source: "cli", ctxId: "cancel-context", requestId: "cancel-request" },
        controller.signal,
    );
    await entered.promise;
    controller.abort(new Error("CONNECTION_CLOSED"));
    release.resolve();
    await assert.rejects(pending, (error: unknown) => {
        const failure = error as { code: string; retryable: boolean };
        assert.equal(failure.code, runtimeErrorCodes.toolCallCancelled);
        assert.equal(failure.retryable, false);
        return true;
    });
    assert.equal(await readFile(path, "utf8"), "committed\n");
    const [record] = await durableCalls(h);
    assert.equal(record?.status, "cancelled");
    assert.equal(record?.ctxId, "cancel-context");
});
