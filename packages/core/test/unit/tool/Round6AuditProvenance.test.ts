import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createRemoteError, runtimeErrorCodes } from "@portable-devshell/shared";
import { barrier, round4Target } from "./Round4Harness.ts";
import { approvalRequested, durableCalls } from "./Round6AuditFixture.ts";

const options = { timeout: 10_000 };

test("round6: progress rewrite failure after commit cannot expose raw terminal output or repeat execution", options, async (t) => {
    const h = await round4Target(); t.after(() => h.close());
    const path = join(h.directory, "progress-effect");
    const progress: unknown[] = [];
    h.runtime.hooks.registerExecute("local_effect", async (_id, _input, _value, _signal, emit) => {
        await appendFile(path, "once\n"); emit?.({ private: "hidden progress" }); return { private: "hidden result" };
    });
    t.mock.method(console, "warn", () => {});
    h.runtime.hooks.registerContributor(() => ({ release() {}, rewrites: [{
        hook: "900-progress", id: "fail-progress", rewrite(input) {
            if (input.direction === "outbound" && input.value.kind === "progress") throw new Error("progress unavailable");
            return input.value;
        },
    }] }));
    await assert.rejects(h.runtime.api.call("round4", "local_effect", {}, { source: "cli", ctxId: "progress-failure" },
        undefined, undefined, undefined, (value) => progress.push(value)), (error: unknown) => {
        const value = error as { code: string; retryable: boolean; details: { executionCompleted: boolean; failureStage: string } };
        assert.equal(value.code, runtimeErrorCodes.toolResultDeliveryFailed); assert.equal(value.retryable, false);
        assert.equal(value.details.executionCompleted, true); assert.equal(value.details.failureStage, "outboundHook"); return true;
    });
    const [record] = await durableCalls(h); assert.ok(record);
    assert.equal(record.status, "failed"); assert.equal(record.executionCompleted, true);
    assert.equal(record.failureStage, "outboundHook"); assert.equal(record.output, undefined);
    assert.deepEqual(progress, []); assert.equal(await readFile(path, "utf8"), "once\n");
    assert.equal(h.history.hasActiveForContext("progress-failure"), false);
});

test("round6: SQLite completion-event rejection preserves the committed terminal row and later failure accounting", options, async (t) => {
    const h = await round4Target(); t.after(() => h.close());
    h.audit.api.toolCalls.readQuery();
    const database = new DatabaseSync(h.databasePath); t.after(() => database.close());
    database.exec(`CREATE TRIGGER round6_terminal_event BEFORE INSERT ON audit_records
        WHEN NEW.collection = 'events' AND json_extract(NEW.payload, '$.type') = 'toolCall.completed'
        BEGIN SELECT RAISE(ABORT, 'round6 completion event unavailable'); END`);
    const warnings = t.mock.method(console, "warn", () => {});
    const path = join(h.directory, "event-fault-effect");
    h.runtime.hooks.registerExecute("local_effect", async () => { await appendFile(path, "once\n"); return { durable: true }; });
    assert.deepEqual(await h.runtime.api.call("round4", "local_effect", {}, { source: "cli", ctxId: "event-fault" }), { durable: true });
    assert.equal(warnings.mock.callCount(), 1);
    assert.match(String(warnings.mock.calls[0]!.arguments[1]), /round6 completion event unavailable/);
    const [record] = await durableCalls(h); assert.equal(record?.status, "completed");
    assert.deepEqual(record?.output, { durable: true }); assert.equal(h.history.hasActiveForContext("event-fault"), false);
    database.exec("DROP TRIGGER round6_terminal_event");
    h.runtime.hooks.registerExecute("fail_next", async () => { throw createRemoteError({ code: "round6.next", message: "next failed", retryable: false }); });
    await assert.rejects(h.runtime.api.call("round4", "fail_next", {}, { source: "cli" }), { code: "round6.next" });
    const summary = await h.history.readFailureSummary(Date.now() - 60_000, Date.now() + 60_000);
    assert.equal(summary.count, 1); assert.equal(summary.latest?.toolName, "fail_next");
    assert.equal((await durableCalls(h)).length, 2); assert.equal(await readFile(path, "utf8"), "once\n");
});

for (const winner of ["approve", "deny"] as const) {
    test(`round6: competing Approval ${winner} first has one durable winner and matching pipeline effect`, options, async (t) => {
        const h = await round4Target(); t.after(() => h.close());
        const path = join(h.directory, "decision-effect");
        // Create the file before the call so denial can assert exact absence of effects.
        await appendFile(path, "");
        h.runtime.hooks.registerExecute("local_effect", async () => { await appendFile(path, "once\n"); return { approved: true }; });
        const requested = approvalRequested(h);
        const call = h.runtime.api.call("round4", "local_effect", { account: "round6" }, {
            source: "web", ctxId: "decision-context", requestId: "decision-request", workspace: h.directory,
        });
        const outcome = Promise.allSettled([call]);
        const id = await requested;
        const decisions = await Promise.allSettled([
            h.approval.decideApproval(id, { decision: winner, decidedBy: "web", reason: "first" }),
            h.approval.decideApproval(id, { decision: winner === "approve" ? "deny" : "approve", decidedBy: "cli", reason: "second" }),
        ]);
        assert.equal(decisions[0]!.status, "fulfilled");
        assert.equal(decisions[1]!.status, "rejected");
        assert.ok(decisions[1]!.status === "rejected");
        assert.equal(decisions[1]!.reason.code, runtimeErrorCodes.approvalAlreadyDecided);
        const [result] = await outcome;
        assert.equal(result!.status, winner === "approve" ? "fulfilled" : "rejected");
        const approval = await h.approval.getApproval(id);
        assert.equal(approval.status, winner === "approve" ? "approved" : "denied");
        assert.equal(approval.decision?.reason, "first"); assert.equal(approval.decision?.decidedBy, "web");
        const [record] = await durableCalls(h); assert.ok(record);
        assert.equal(record.callId, approval.callId); assert.equal(record.ctxId, approval.ctxId);
        assert.equal(record.requestId, approval.requestId); assert.equal(record.workspace, approval.workspace);
        assert.equal(record.status, winner === "approve" ? "completed" : "denied");
        assert.equal(await readFile(path, "utf8"), winner === "approve" ? "once\n" : "");
        assert.equal(h.events.filter((event) => event.type === `approval.${approval.status}`).length, 1);
        assert.deepEqual(await h.approval.listPendingApprovals(), []);
        assert.equal(h.history.hasActiveForContext("decision-context"), false);
    });
}

test("round6: abort after durable approval but before dispatch cannot execute or revise the approval", options, async (t) => {
    const h = await round4Target();
    const path = join(h.directory, "approved-abort-effect"); await appendFile(path, "");
    const requested = approvalRequested(h); const rewriting = barrier(); const release = barrier();
    t.after(async () => { release.resolve(); await h.close(); });
    h.runtime.hooks.registerContributor(() => ({ release() {}, rewrites: [{ hook: "900-gate", id: "after-approval",
        async rewrite(input) { if (input.direction === "inbound") { rewriting.resolve(); await release.promise; } return input.value; },
    }] }));
    h.runtime.hooks.registerExecute("local_effect", async () => { await appendFile(path, "unexpected"); return {}; });
    const controller = new AbortController();
    const call = h.runtime.api.call("round4", "local_effect", {}, { source: "cli", ctxId: "approved-abort" }, controller.signal);
    const rejected = assert.rejects(call, { code: runtimeErrorCodes.toolCallCancelled });
    const id = await requested;
    await h.approval.decideApproval(id, { decision: "approve", decidedBy: "cli" });
    await rewriting.promise; controller.abort("after approval"); release.resolve(); await rejected;
    const [record] = await durableCalls(h); assert.ok(record);
    assert.equal(record.callId, (await h.approval.getApproval(id)).callId);
    assert.equal(record.executionCompleted, undefined); assert.equal(record.output, undefined);
    assert.equal(record.error, runtimeErrorCodes.toolCallCancelled);
    assert.equal((await h.approval.getApproval(id)).status, "approved");
    assert.equal(await readFile(path, "utf8"), ""); assert.equal(h.history.hasActiveForContext("approved-abort"), false);
});

test("round6: repeated requestId is correlation only and concurrent calls retain separate execution identities", options, async (t) => {
    const h = await round4Target();
    const path = join(h.directory, "duplicate-request-effects");
    const entered = barrier(); const release = barrier(); t.after(async () => { release.resolve(); await h.close(); });
    const ids = new Set<string>();
    h.runtime.hooks.registerExecute("local_effect", async (id) => {
        ids.add(id); await appendFile(path, `${id}\n`);
        if (ids.size === 2) entered.resolve(); await release.promise; return { id };
    });
    const context = { source: "cli" as const, ctxId: "same-context", requestId: "same-request" };
    const calls = [h.runtime.api.call("round4", "local_effect", { n: 1 }, context), h.runtime.api.call("round4", "local_effect", { n: 2 }, context)];
    await entered.promise;
    const active = await h.history.read({ ctxId: "same-context" }); assert.equal(active.length, 2);
    assert.equal(new Set(active.map(({ callId }) => callId)).size, 2);
    release.resolve(); const results = await Promise.all(calls);
    const records = await durableCalls(h); assert.equal(records.length, 2);
    assert.deepEqual(new Set(records.map(({ callId }) => callId)), ids);
    assert.deepEqual(new Set((await readFile(path, "utf8")).trim().split("\n")), ids);
    for (const record of records) {
        assert.equal(record.status, "completed"); assert.equal(record.requestId, "same-request");
        assert.ok(results.some((result) => JSON.stringify(result) === JSON.stringify(record.output)));
    }
    assert.equal(h.history.hasActiveForContext("same-context"), false);
});

test("round6: invocation preparation failure records original input without executing and next call can commit", options, async (t) => {
    const h = await round4Target(); t.after(() => h.close());
    const path = join(h.directory, "preparation-effect"); await appendFile(path, "");
    h.runtime.hooks.registerExecute("local_effect", async (_id, input) => { await appendFile(path, "once\n"); return input; });
    await assert.rejects(h.runtime.api.call("round4", "local_effect", { original: true }, {
        source: "mcp", ctxId: "preparation-context", requestId: "preparation-request",
    }, undefined, undefined, async () => {
        throw createRemoteError({ code: "round6.prepare", message: "preparation rejected", retryable: false });
    }), { code: "round6.prepare" });
    assert.equal(await readFile(path, "utf8"), "");
    assert.deepEqual(await h.runtime.api.call("round4", "local_effect", { next: true }, { source: "mcp", ctxId: "preparation-context" }), { next: true });
    const records = await durableCalls(h); assert.equal(records.length, 2);
    const failed = records.find(({ requestId }) => requestId === "preparation-request"); assert.ok(failed);
    assert.equal(failed.status, "failed"); assert.equal(failed.error, "round6.prepare");
    assert.deepEqual(failed.input, { original: true }); assert.equal(failed.executionCompleted, undefined);
    assert.equal(failed.failureStage, undefined); assert.equal(failed.output, undefined);
    assert.equal(await readFile(path, "utf8"), "once\n"); assert.equal(h.history.hasActiveForContext("preparation-context"), false);
});
