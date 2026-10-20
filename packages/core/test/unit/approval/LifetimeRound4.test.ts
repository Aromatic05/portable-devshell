import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runtimeErrorCodes } from "@portable-devshell/shared";
import { ApprovalService } from "../../../src/approval/execution/Service.ts";
import { InstanceApprovalStore } from "../../../src/approval/Store.ts";
import { round4Target, barrier } from "../tool/Round4Harness.ts";

const input = { callId: "persist-race", source: "cli" as const, ctxId: "approval-context", toolName: "local_effect", inputSummary: "{}" };

test("round4: abort while initial approval persistence is suspended wins over a late approval", async (t) => {
    const h = await round4Target(); t.after(() => h.close());
    const store = new InstanceApprovalStore(h.audit.api.state("persist-race"));
    const entered = barrier(); const release = barrier();
    const service = new ApprovalService({ instanceName: h.instanceName, policy: { mode: "ask" },
        store: {
            list: () => store.list(), get: (id) => store.get(id), delete: (id) => store.delete(id),
            async append(request) {
                await store.append(request);
                if (request.status === "pending") { entered.resolve(); await release.promise; }
            },
        }, events: { append: async () => {} },
    });
    t.after(() => service.close());
    const controller = new AbortController();
    const evaluating = service.evaluate(input, controller.signal);
    await entered.promise; controller.abort("cancelled during persistence"); release.resolve();
    const evaluation = await evaluating;
    assert.ok(evaluation.decision === "ask");
    assert.equal((await evaluation.awaitDecision).status, "cancelled");
    await assert.rejects(service.decideApproval(evaluation.request.approvalId, { decision: "approve", decidedBy: "cli" }),
        { code: runtimeErrorCodes.approvalAlreadyDecided });
    assert.equal((await store.get(evaluation.request.approvalId))?.status, "cancelled");
    assert.deepEqual(await service.listPendingApprovals("approval-context"), []);
});

test("round4: failed SQLite approval event cannot strand a durably approved waiter or permit a second decision", async (t) => {
    const h = await round4Target(); t.after(() => h.close());
    const evaluation = await h.approval.evaluate(input);
    assert.ok(evaluation.decision === "ask");
    const fault = new DatabaseSync(h.databasePath); t.after(() => fault.close());
    fault.exec(`CREATE TRIGGER round4_fail_approval_event BEFORE INSERT ON audit_records
        WHEN NEW.collection = 'events' BEGIN SELECT RAISE(ABORT, 'round4 event insert failure'); END`);
    await assert.rejects(h.approval.decideApproval(evaluation.request.approvalId, { decision: "approve", decidedBy: "cli" }),
        /round4 event insert failure/);
    assert.equal((await evaluation.awaitDecision).status, "approved");
    assert.equal((await h.approval.getApproval(evaluation.request.approvalId)).status, "approved");
    assert.deepEqual(await h.approval.listPendingApprovals(), []);
    await assert.rejects(h.approval.decideApproval(evaluation.request.approvalId, { decision: "deny", decidedBy: "cli" }),
        { code: runtimeErrorCodes.approvalAlreadyDecided });
    fault.exec("DROP TRIGGER round4_fail_approval_event");
    const recovered = new ApprovalService({ instanceName: h.instanceName,
        store: new InstanceApprovalStore(h.audit.api.state("approvals")), events: { append: async () => {} },
    });
    t.after(() => recovered.close());
    assert.equal((await recovered.getApproval(evaluation.request.approvalId)).status, "approved");
});
