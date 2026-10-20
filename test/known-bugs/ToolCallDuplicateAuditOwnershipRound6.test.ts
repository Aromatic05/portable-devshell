import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createToolCallTargetTransport, type ToolCallDispatchRequest } from "@portable-devshell/shared";
import { barrier } from "../../packages/core/test/unit/tool/Round4Harness.ts";
import { round4Control } from "../../packages/control/test/integration/server/transport/Round4Harness.ts";
import { durableCalls } from "../../packages/core/test/unit/tool/Round6AuditFixture.ts";

test("round6 RED: duplicate active callId rejection must not overwrite the original caller audit ownership", { timeout: 10_000 }, async (t) => {
    const h = await round4Control(); t.after(() => h.close());
    const target = createToolCallTargetTransport(h.bridge, "round4");
    const entered = barrier(); const release = barrier();
    const path = join(h.directory, "duplicate-effect");
    const request: ToolCallDispatchRequest = {
        callId: "round6-fixed-call-id", recording: "host",
        hooks: { async review() { return { decision: "continue" }; }, async rewrite(input) { return input.value; } },
        value: { kind: "call", toolName: "local_effect", payload: { original: true },
            context: { instance: h.instanceName, source: "cli", ctxId: "original-context", requestId: "original-request" } },
        async execute() { await appendFile(path, "once\n"); entered.resolve(); await release.promise; return { original: true }; },
    };
    const first = target.dispatch(request);
    await entered.promise;
    try {
        await assert.rejects(target.dispatch({ ...request,
            value: { ...request.value, payload: { duplicate: true }, context: {
                ...request.value.context, ctxId: "duplicate-context", requestId: "duplicate-request",
            } },
        }), /already reserved/);
    } finally { release.resolve(); }
    assert.deepEqual(await first, { original: true });
    assert.equal(await readFile(path, "utf8"), "once\n");
    const records = await durableCalls(h); assert.equal(records.length, 1);
    t.diagnostic(JSON.stringify(records));
    assert.equal(records[0]!.ctxId, "original-context");
    assert.equal(records[0]!.requestId, "original-request");
    assert.equal(records[0]!.status, "completed");
    assert.deepEqual(records[0]!.output, { original: true });
});
