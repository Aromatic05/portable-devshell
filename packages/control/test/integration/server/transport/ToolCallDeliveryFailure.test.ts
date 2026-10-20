import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createToolTransport, runtimeErrorCodes } from "@portable-devshell/shared";
import { round4Control } from "./Round4Harness.ts";

for (const streaming of [false, true]) {
    test(`Control ${streaming ? 'callStream' : 'call'} retains executionCompleted after an executed side effect and delivery failure`, async (t) => {
        const h = await round4Control(); t.after(() => h.close());
        const path = join(h.directory, "executed.txt");
        h.runtime.hooks.registerExecute("local_effect", async () => { await appendFile(path, "once\n"); return { secret: "private raw output" }; });
        h.runtime.hooks.registerContributor(() => ({ release() {}, rewrites: [{
            hook: "900-fail", id: "fail", rewrite(input) {
                if (input.direction === "outbound") throw new Error("delivery failure");
                return input.value;
            },
        }] }));
        const transport = createToolTransport(await h.connect(), "round4");
        const result = await (streaming ? transport.callStreaming("local_effect", {}, h.directory) : transport.call("local_effect", {}, h.directory));
        assert.equal(await readFile(path, "utf8"), "once\n");
        const [record] = await h.history.read(); assert.equal(record?.executionCompleted, true);
        const failure = result as { error: { code: string; retryable: boolean; details?: { executionCompleted?: boolean; failureStage?: string; callId?: string } } };
        assert.equal(failure.error.code, runtimeErrorCodes.toolResultDeliveryFailed);
        assert.equal(failure.error.retryable, false);
        assert.equal(failure.error.details?.executionCompleted, true);
        assert.equal(failure.error.details?.failureStage, "outboundHook");
        assert.equal(failure.error.details?.callId, record?.callId);
    });
}
