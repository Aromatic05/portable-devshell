import assert from "node:assert/strict";
import test from "node:test";
import { round4Target, barrier } from "../tool/Round4Harness.ts";
import { registerApprovalToolCallReview } from "../../../src/approval/execution/ToolCallReview.ts";
import { InstanceApprovalStore } from "../../../src/approval/Store.ts";
import { ApprovalService } from "../../../src/approval/execution/Service.ts";

for (const decision of ["approve", "deny"] as const) {
    test(`complete immutable Review input is durable before ${decision}, with a compact summary`, async (t) => {
        const h = await round4Target();
        t.after(() => h.close());
        const ready = barrier();
        registerApprovalToolCallReview(h.runtime.hooks, { async evaluate(input, signal) {
            const result = await h.approval.evaluate(input, signal);
            ready.resolve();
            return result;
        } });
        h.runtime.hooks.registerContributor(() => ({
            rewrites: [{ hook: "test", id: "rewrite", rewrite: (input) =>
                input.direction === "inbound" && input.value.kind === "call"
                    ? { ...input.value, payload: { command: "intentionally rewritten" } } : input.value }],
            release() {},
        }));
        let executions = 0;
        h.runtime.hooks.registerExecute("local_effect", async (_callId, input) => {
            assert.deepEqual(input, { command: "intentionally rewritten" });
            executions++;
            return {};
        });
        const payload = { command: "safe prefix " + "x".repeat(16000) + "\nTAIL-ORIGINAL-SENTINEL" };
        const call = h.runtime.api.call(h.instanceName, "local_effect", payload,
            { source: "mcp", ctxId: "ctx-review", workspace: h.directory });
        const completed = decision === "deny" ? assert.rejects(call, { code: "core.toolCallRejected" }) : call;
        await ready.promise;
        const pending = (await h.approval.listPendingApprovals())[0]!;
        assert.equal(pending.status, "pending");
        assert.equal(executions, 0);
        assert.deepEqual(await h.history.read(), []);
        assert.equal(pending.originalInput, JSON.stringify(payload));
        assert.ok(pending.inputSummary.length <= 512);
        assert.equal(pending.inputSummary.includes("TAIL-ORIGINAL-SENTINEL"), false);
        const store = new InstanceApprovalStore(h.audit.api.state("approvals"));
        assert.equal((await store.get(pending.approvalId))?.originalInput, JSON.stringify(payload));
        assert.equal(JSON.stringify(h.events).includes("TAIL-ORIGINAL-SENTINEL"), false);
        // A client mutating its returned projection cannot rewrite the durable snapshot.
        Object.assign(pending, { originalInput: "client change" });
        assert.equal((await h.approval.getApproval(pending.approvalId)).originalInput, JSON.stringify(payload));
        await h.approval.decideApproval(pending.approvalId, { decision, decidedBy: "web" });
        await completed;
        assert.equal(executions, decision === "approve" ? 1 : 0);
        assert.equal((await h.approval.getApproval(pending.approvalId)).originalInput, JSON.stringify(payload));
        const reloaded = new ApprovalService({ instanceName: h.instanceName, store, events: { append: async () => {} } });
        t.after(() => reloaded.close());
        assert.equal((await reloaded.getApproval(pending.approvalId)).originalInput, JSON.stringify(payload));
    });
}
