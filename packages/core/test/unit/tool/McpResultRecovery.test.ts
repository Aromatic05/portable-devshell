import assert from "node:assert/strict";
import test from "node:test";
import { presentToolCallResult, runtimeErrorCodes, type RemoteErrorBody } from "@portable-devshell/shared";
import { round4Target } from "./Round4Harness.ts";

test("native result adaptation failure cannot recover into a malformed Host envelope or repeat execution", async (t) => {
    const h = await round4Target();
    t.after(() => h.close());
    let effects = 0;
    h.runtime.hooks.registerExecute("native_read", async () => {
        effects++;
        return presentToolCallResult({ message: "SENTINEL structured" }, {
            content: [{ type: "text", text: "SENTINEL native" }],
        });
    });
    h.runtime.hooks.registerContributor(() => ({
        release() {},
        rewrites: [{ hook: "recover", id: "recover", rewrite(input) {
            if (input.direction === "outbound" && input.value.kind === "error") {
                return { ...input.value, kind: "result", payload: { message: "recovered" } };
            }
            return input.value;
        } }],
    }));
    await assert.rejects(h.runtime.api.call("round4", "native_read", {}, { source: "mcp" },
        undefined, async () => { throw new Error("adaptation failed"); }), (error: unknown) => {
        const failure = error as RemoteErrorBody;
        assert.equal(failure.code, runtimeErrorCodes.toolResultDeliveryFailed);
        assert.equal(failure.retryable, false);
        const details = failure.details as Record<string, unknown>;
        assert.equal(details.executionCompleted, true);
        assert.equal(details.failureStage, "outboundHook");
        return true;
    });
    assert.equal(effects, 1);
    const [record] = await h.history.read();
    assert.equal(record?.executionCompleted, true);
    assert.equal(record?.failureStage, "outboundHook");
    assert.equal(record?.output, undefined);
});
