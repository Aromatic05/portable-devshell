import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runtimeErrorCodes } from "@portable-devshell/shared";
import { ApprovalService } from "../../../src/approval/execution/Service.ts";
import { InstanceApprovalStore } from "../../../src/approval/Store.ts";
import { createAuditRuntime } from "../../../src/audit/index.ts";
import { round4Target, barrier } from "../tool/Round4Harness.ts";
import { approvalRequested } from "../tool/Round6AuditFixture.ts";

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

for (const failedType of ["approval.requested", "approval.approved"] as const) {
    test(`SQLite ${failedType} failure keeps the inbound call live and its outbox survives reopening`, async (t) => {
        const h = await round4Target(); t.after(() => h.close());
        h.audit.api.events.readHighWater();
        const fault = new DatabaseSync(h.databasePath); t.after(() => fault.close());
        fault.exec(`CREATE TRIGGER fail_delivery BEFORE INSERT ON audit_records
            WHEN NEW.collection = 'events' AND json_extract(NEW.payload, '$.type') = '${failedType}'
            BEGIN SELECT RAISE(ABORT, 'injected SQLite delivery failure'); END`);
        let effects = 0;
        h.runtime.hooks.registerExecute("local_effect", async () => { effects++; return { committed: true }; });
        const requested = approvalRequested(h);
        const outcome = Promise.allSettled([h.runtime.api.call(h.instanceName, "local_effect", {}, {
            source: "mcp", ctxId: "event-context", requestId: "event-request", workspace: h.directory,
        })]);
        const id = await requested;
        assert.equal(effects, 0);
        assert.deepEqual(await h.history.read(), []);
        assert.equal((await h.approval.listPendingApprovals("event-context"))[0]?.approvalId, id);
        assert.equal((await h.approval.decideApproval(id, { decision: "approve", decidedBy: "web" })).status, "approved");
        assert.equal((await outcome)[0]?.status, "fulfilled");
        assert.equal(effects, 1);
        assert.equal((await h.history.read())[0]?.status, "completed");
        assert.deepEqual(await h.approval.listPendingApprovals(), []);
        h.approval.close();
        fault.exec("DROP TRIGGER fail_delivery");
        await h.audit.close();
        const reopened = createAuditRuntime({ instanceName: h.instanceName, filePath: h.databasePath, eventBufferSize: 100 });
        t.after(() => reopened.close());
        const recovered = new ApprovalService({ instanceName: h.instanceName,
            store: new InstanceApprovalStore(reopened.api.state("approvals")),
            events: { async append(type, data) {
                await reopened.api.events.append({ type, data, seq: reopened.api.events.readHighWater() + 1,
                    at: new Date().toISOString(), instanceName: h.instanceName });
            } },
        });
        t.after(() => recovered.close());
        assert.equal((await recovered.getApproval(id)).status, "approved");
        const replay = reopened.api.events.readFrom(1, 100).filter(event => event.type.startsWith("approval."));
        assert.deepEqual(replay.map(event => event.type), ["approval.requested", "approval.approved"]);
        const failed = replay.find(event => event.type === failedType);
        assert.match(JSON.stringify(failed?.data), /eventAppendFailure.*injected SQLite delivery failure/);
        await recovered.listApprovals();
        assert.equal(reopened.api.events.readFrom(1, 100).filter(event => event.type.startsWith("approval.")).length, 2);
        assert.equal(effects, 1);
    });
}

test("round4: failed SQLite approval event cannot strand a durably approved waiter or permit a second decision", async (t) => {
    const h = await round4Target(); t.after(() => h.close());
    const evaluation = await h.approval.evaluate(input);
    assert.ok(evaluation.decision === "ask");
    const fault = new DatabaseSync(h.databasePath); t.after(() => fault.close());
    fault.exec(`CREATE TRIGGER round4_fail_approval_event BEFORE INSERT ON audit_records
        WHEN NEW.collection = 'events' BEGIN SELECT RAISE(ABORT, 'round4 event insert failure'); END`);
    assert.equal((await h.approval.decideApproval(evaluation.request.approvalId, { decision: "approve", decidedBy: "cli" })).status,
        "approved");
    assert.equal((await evaluation.awaitDecision).status, "approved");
    assert.equal((await h.approval.getApproval(evaluation.request.approvalId)).status, "approved");
    assert.deepEqual(await h.approval.listPendingApprovals(), []);
    await assert.rejects(h.approval.decideApproval(evaluation.request.approvalId, { decision: "deny", decidedBy: "cli" }),
        { code: runtimeErrorCodes.approvalAlreadyDecided });
    fault.exec("DROP TRIGGER round4_fail_approval_event");
    const replayed: unknown[] = [];
    const recovered = new ApprovalService({ instanceName: h.instanceName,
        store: new InstanceApprovalStore(h.audit.api.state("approvals")), events: { append: async (type, data) => {
            replayed.push({ type, data });
        } },
    });
    t.after(() => recovered.close());
    assert.equal((await recovered.getApproval(evaluation.request.approvalId)).status, "approved");
    assert.equal(replayed.length, 1);
    assert.equal((replayed[0] as { type: string }).type, "approval.approved");
    assert.match(JSON.stringify(replayed[0]), /round4 event insert failure/);
});
