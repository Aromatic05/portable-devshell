import assert from "node:assert/strict";
import test from "node:test";
import { createPortClient, createToolTransport, runtimeErrorCodes } from "@portable-devshell/shared";
import { registerApprovalToolCallReview } from "../../../../../core/src/approval/execution/ToolCallReview.ts";
import { barrier } from "../../../../../core/test/unit/tool/Round4Harness.ts";
import { round4Control } from "./Round4Harness.ts";

for (const interruption of ["cancel", "disconnect", "stream"] as const) {
    test(`pending approval terminates on RPC ${interruption} before any executor runs`, { timeout: 5000 }, async (t) => {
        const h = await round4Control();
        t.after(async () => { await h.approval.retire(); await h.close(); });
        const requested = barrier<string>();
        const cancelled = barrier();
        const evaluate = h.approval.evaluate.bind(h.approval);
        const cancel = h.approval.cancel.bind(h.approval);
        h.approval.cancel = async (...args) => {
            const result = await cancel(...args);
            assert.equal(result.status, "cancelled");
            cancelled.resolve();
            return result;
        };
        registerApprovalToolCallReview(h.runtime.hooks, {
            async evaluate(input, signal) {
                const result = await evaluate(input, signal);
                assert.ok(result.decision === "ask");
                requested.resolve(result.request.approvalId);
                return result;
            },
        });
        let executions = 0;
        h.runtime.hooks.registerExecute("local_effect", async () => { executions += 1; return {}; });
        const endpoint = await h.connect("approval-owner");
        const abort = new AbortController();
        const call = interruption === "stream"
            ? createToolTransport(endpoint, "round4").callStreaming("local_effect", {}, h.directory, { signal: abort.signal })
            : createPortClient(endpoint, "round4", "tool").request("call", {
                toolName: "local_effect", input: {}, workspace: h.directory,
            }, abort.signal);
        const rejected = assert.rejects(call);
        const approvalId = await requested.promise;
        if (interruption === "disconnect") endpoint.close();
        else abort.abort(new Error("caller cancelled before approval"));
        await rejected;
        let timer: ReturnType<typeof setTimeout>;
        try {
            await Promise.race([cancelled.promise, new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("approval did not receive cancellation")), 1000);
            })]);
        } finally { clearTimeout(timer!); }
        assert.equal((await h.approval.getApproval(approvalId)).status, "cancelled");
        await assert.rejects(h.approval.decideApproval(approvalId, { decision: "approve", decidedBy: "cli" }),
            { code: runtimeErrorCodes.approvalAlreadyDecided });
        assert.equal(executions, 0);
        assert.deepEqual(await h.approval.listPendingApprovals(), []);
    });
}
