import assert from "node:assert/strict";
import test from "node:test";
import { round4Target, barrier } from "../tool/Round4Harness.ts";
import { ApprovalService } from "../../../src/approval/execution/Service.ts";
import { InstanceApprovalStore } from "../../../src/approval/Store.ts";

test("ApprovalService close during pending persistence cannot publish a new live approval after close", async (t) => {
    const h = await round4Target(); t.after(() => h.close());
    const store = new InstanceApprovalStore(h.audit.api.state("close-race"));
    const entered = barrier(); const release = barrier();
    const service = new ApprovalService({ instanceName: h.instanceName, policy: { mode: "ask" },
        events: { append: async () => {} }, store: {
            list: () => store.list(), get: (id) => store.get(id), delete: (id) => store.delete(id),
            async append(request) { await store.append(request); entered.resolve(); await release.promise; },
        },
    });
    t.after(() => service.close());
    const evaluating = service.evaluate({ callId: "close-race", source: "cli", toolName: "local_effect", inputSummary: "{}" });
    await entered.promise;
    service.close(); release.resolve();
    const evaluation = await evaluating;
    assert.ok(evaluation.decision === "ask");
    const pendingAfterClose = await service.listPendingApprovals();
    t.diagnostic(`pending approvals published after close: ${pendingAfterClose.length}`);
    await service.decideApproval(evaluation.request.approvalId, { decision: "approve", decidedBy: "cli" });
    assert.equal((await evaluation.awaitDecision).status, "cancelled");
});
