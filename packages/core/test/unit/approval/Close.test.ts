import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runtimeErrorCodes, toRemoteErrorBody, type ApprovalRequest } from "@portable-devshell/shared";
import { ApprovalService } from "../../../src/approval/execution/Service.ts";
import { InstanceApprovalStore } from "../../../src/approval/Store.ts";
import { registerApprovalToolCallReview } from "../../../src/approval/execution/ToolCallReview.ts";
import { barrier, round4Target } from "../tool/Round4Harness.ts";

const input = { callId: "close", source: "cli" as const, toolName: "local_effect", inputSummary: "{}" };

for (const committed of [false, true]) {
    test(`close fences a decision suspended in persistence (committed=${committed})`, async (t) => {
        const h = await round4Target();
        t.after(() => h.close());
        const store = new InstanceApprovalStore(h.audit.api.state("close-decision"));
        const entered = barrier();
        const release = barrier();
        t.after(() => release.resolve());
        const events: string[] = [];
        const service = new ApprovalService({
            instanceName: h.instanceName, policy: { mode: "ask" },
            store: {
                list: () => store.list(), get: (id) => store.get(id), delete: (id) => store.delete(id),
                async append(request) {
                    if (request.status === "approved") {
                        if (committed) await store.append(request);
                        entered.resolve();
                        await release.promise;
                    }
                    await store.append(request);
                },
            },
            events: { async append(type) { events.push(type); } },
        });
        t.after(() => service.close());
        const evaluation = await service.evaluate(input);
        assert.ok(evaluation.decision === "ask");
        const deciding = service.decideApproval(evaluation.request.approvalId, { decision: "approve", decidedBy: "cli" });
        await entered.promise;
        const queuedEvaluation = service.evaluate({ ...input, callId: "queued-after-decision" });
        service.close();
        service.close();
        assert.equal((await evaluation.awaitDecision).status, "cancelled");
        release.resolve();
        assert.equal((await deciding).status, "cancelled");
        const queued = await queuedEvaluation;
        assert.ok(queued.decision === "deny");
        assert.equal(queued.error.code, runtimeErrorCodes.toolCallCancelled);
        const stored = await store.get(evaluation.request.approvalId);
        assert.equal(stored?.status, "cancelled");
        assert.equal(stored?.decision, undefined);
        assert.equal((await store.list()).length, 1);
        assert.deepEqual(events, ["approval.requested", "approval.cancelled"]);
        assert.deepEqual(await service.listPendingApprovals(), []);
        const recovered = new ApprovalService({ instanceName: h.instanceName, store, events: { async append() {} } });
        t.after(() => recovered.close());
        assert.deepEqual(await recovered.getApproval(evaluation.request.approvalId), stored);
    });
}

test("close during initialization denies queued and subsequent evaluations even for allow policy", async (t) => {
    const h = await round4Target();
    t.after(() => h.close());
    const entered = barrier();
    const release = barrier();
    t.after(() => release.resolve());
    const writes: ApprovalRequest[] = [];
    const service = new ApprovalService({
        instanceName: h.instanceName, policy: { mode: "allow" },
        store: {
            async list() { entered.resolve(); await release.promise; return []; },
            async append(request) { writes.push(request); },
            async get() { return undefined; }, async delete() {},
        },
        events: { async append() { assert.fail("closed admission must not emit"); } },
    });
    const queued = service.evaluate(input);
    await entered.promise;
    service.close();
    release.resolve();
    for (const evaluation of [await queued, await service.evaluate(input)]) {
        assert.ok(evaluation.decision === "deny");
        assert.equal(evaluation.error.code, runtimeErrorCodes.toolCallCancelled);
    }
    assert.deepEqual(writes, []);
});

test("close while requested event is pending cancels publication and a queued decision", async (t) => {
    const h = await round4Target();
    t.after(() => h.close());
    const store = new InstanceApprovalStore(h.audit.api.state("close-publication"));
    const entered = barrier();
    const release = barrier();
    t.after(() => release.resolve());
    const events: string[] = [];
    const service = new ApprovalService({
        instanceName: h.instanceName, policy: { mode: "ask" }, createId: () => "publication",
        store, events: { async append(type) {
            if (type === "approval.requested") { entered.resolve(); await release.promise; }
            events.push(type);
        } },
    });
    t.after(() => service.close());
    const evaluating = service.evaluate(input);
    await entered.promise;
    const deciding = service.decideApproval("publication", { decision: "approve", decidedBy: "web" });
    service.close();
    assert.deepEqual(await service.listPendingApprovals(), []);
    release.resolve();
    const evaluation = await evaluating;
    assert.ok(evaluation.decision === "ask");
    assert.equal((await evaluation.awaitDecision).status, "cancelled");
    assert.equal((await deciding).status, "cancelled");
    assert.equal((await store.get("publication"))?.status, "cancelled");
    assert.deepEqual(events, ["approval.requested", "approval.cancelled"]);
});

test("durably completed decision resolves before a slow terminal event and survives close", async (t) => {
    const h = await round4Target();
    t.after(() => h.close());
    const store = new InstanceApprovalStore(h.audit.api.state("close-terminal-event"));
    const entered = barrier();
    const release = barrier();
    t.after(() => release.resolve());
    const service = new ApprovalService({
        instanceName: h.instanceName, policy: { mode: "ask" }, store,
        events: { async append(type) {
            if (type === "approval.approved") { entered.resolve(); await release.promise; }
        } },
    });
    t.after(() => service.close());
    const evaluation = await service.evaluate(input);
    assert.ok(evaluation.decision === "ask");
    const deciding = service.decideApproval(evaluation.request.approvalId, { decision: "approve", decidedBy: "web" });
    await entered.promise;
    assert.equal((await evaluation.awaitDecision).status, "approved");
    service.close();
    release.resolve();
    assert.equal((await deciding).status, "approved");
    assert.equal((await store.get(evaluation.request.approvalId))?.status, "approved");
});

for (const phase of ["pending", "approved"] as const) {
    test(`ToolCall pipeline cannot execute an effect when close interrupts ${phase} persistence`, async (t) => {
        const h = await round4Target();
        t.after(() => h.close());
        const store = new InstanceApprovalStore(h.audit.api.state("pipeline-close"));
        const entered = barrier();
        const release = barrier();
        const requested = barrier();
        t.after(() => release.resolve());
        const events: string[] = [];
        const service = new ApprovalService({
            instanceName: h.instanceName, policy: { mode: "ask" }, createId: () => "pipeline",
            store: {
                list: () => store.list(), get: (id) => store.get(id), delete: (id) => store.delete(id),
                async append(request) {
                    await store.append(request);
                    if (request.status === phase) { entered.resolve(); await release.promise; }
                },
            }, events: { async append(type) {
                events.push(type);
                if (type === "approval.requested") requested.resolve();
            } },
        });
        t.after(() => service.close());
        registerApprovalToolCallReview(h.runtime.hooks, service);
        const effect = join(h.directory, "forbidden-effect.txt");
        let executions = 0;
        h.runtime.hooks.registerExecute("local_effect", async () => {
            executions += 1;
            await writeFile(effect, "executed");
            return { ok: true };
        });
        const operation = assert.rejects(h.runtime.api.call(h.instanceName, "local_effect", {}, { source: "cli" }),
            (error: unknown) => {
                const body = toRemoteErrorBody(error);
                assert.equal(body?.code, runtimeErrorCodes.toolCallRejected);
                assert.equal(body?.cause?.code, runtimeErrorCodes.toolCallCancelled);
                return true;
            });
        let deciding: Promise<ApprovalRequest> | undefined;
        if (phase === "approved") {
            await requested.promise;
            deciding = service.decideApproval("pipeline", { decision: "approve", decidedBy: "cli" });
        }
        await entered.promise;
        service.close();
        release.resolve();
        await operation;
        await deciding;
        assert.equal(executions, 0);
        await assert.rejects(readFile(effect), { code: "ENOENT" });
        assert.equal((await store.get("pipeline"))?.status, "cancelled");
        assert.deepEqual(await service.listPendingApprovals(), []);
        assert.equal(events.includes("approval.approved"), false);
        assert.equal(events.includes("approval.requested"), phase === "approved");
        const records = await h.history.read();
        assert.equal(records.length, 1);
        assert.equal(records[0]?.status, "denied");
    });
}

test("failed close cancellation rejects evaluation without publication and remains recoverable", async (t) => {
    const h = await round4Target();
    t.after(() => h.close());
    const store = new InstanceApprovalStore(h.audit.api.state("close-write-failure"));
    const entered = barrier();
    const release = barrier();
    t.after(() => release.resolve());
    const service = new ApprovalService({
        instanceName: h.instanceName, policy: { mode: "ask" }, createId: () => "failed-cancel",
        store: {
            list: () => store.list(), get: (id) => store.get(id), delete: (id) => store.delete(id),
            async append(request) {
                if (request.status === "cancelled") throw new Error("cancellation persistence failed");
                await store.append(request);
                entered.resolve();
                await release.promise;
            },
        }, events: { async append() { assert.fail("failed cancellation must not publish"); } },
    });
    const evaluating = assert.rejects(service.evaluate(input), /cancellation persistence failed/u);
    await entered.promise;
    service.close();
    release.resolve();
    await evaluating;
    assert.deepEqual(await service.listPendingApprovals(), []);
    assert.equal((await store.get("failed-cancel"))?.status, "pending");
    const recovered = new ApprovalService({ instanceName: h.instanceName, store, events: { async append() {} } });
    t.after(() => recovered.close());
    assert.equal((await recovered.getApproval("failed-cancel")).status, "cancelled");
});
