import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createToolTransport, runtimeErrorCodes } from "@portable-devshell/shared";
import { round4Control } from "../../packages/control/test/integration/server/transport/Round4Harness.ts";
import { round4Target, barrier } from "../../packages/core/test/unit/tool/Round4Harness.ts";
import { ApprovalService } from "../../packages/core/src/approval/execution/Service.ts";
import { InstanceApprovalStore } from "../../packages/core/src/approval/Store.ts";

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
