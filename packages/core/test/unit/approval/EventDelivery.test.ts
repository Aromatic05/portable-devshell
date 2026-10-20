import assert from "node:assert/strict";
import test from "node:test";
import {
    asInstanceName,
    createToolCallRuntime,
    runtimeErrorCodes,
    type ApprovalRequest,
    type JsonValue,
    type ToolCallRecord,
} from "@portable-devshell/shared";
import type { ApprovalEvaluation } from "../../../src/approval/Api.ts";
import { ApprovalService, type ApprovalEventPort, type ApprovalRecord } from "../../../src/approval/execution/Service.ts";
import { registerApprovalToolCallReview } from "../../../src/approval/execution/ToolCallReview.ts";
import { InstanceApprovalStore } from "../../../src/approval/Store.ts";
import { WorkerInstanceTool } from "../../../src/toolcall/execution/Tool.ts";
import { ToolCallHistory } from "../../../src/toolcall/execution/record/History.ts";
import { WorkerToolCallScheduler } from "../../../src/toolcall/execution/Scheduler.ts";

function fixture(t: test.TestContext, failedType: string) {
    const instanceName = asInstanceName("approval-events");
    const records = new Map<string, ApprovalRequest>();
    const store = new InstanceApprovalStore({
        async put(id, value) { records.set(id, structuredClone(value)); },
        async get(id) { return structuredClone(records.get(id)); },
        async list() { return structuredClone([...records.values()]); },
        async delete(id) { records.delete(id); },
    });
    let failing = true;
    const events: { type: string; data: Record<string, JsonValue> }[] = [];
    const eventPort: ApprovalEventPort = { async append(type, data) {
        if (failing && type === failedType)
            throw Object.assign(new Error("injected event append EIO"), { code: "EIO" });
        events.push({ type, data: structuredClone(data) });
    } };
    const options = { instanceName, store, events: eventPort, policy: { mode: "ask" as const },
        createId: () => "approval-1", now: () => 0 };
    const service = new ApprovalService(options);
    const calls: ToolCallRecord[] = [];
    const history = new ToolCallHistory(instanceName, {
        async append(record) { calls.push(record); },
        hasCall(id) { return calls.some(record => record.callId === id); },
        readQuery() { return calls; },
        readFailureSummary() { assert.fail("not used by approval execution"); },
    });
    const scheduler = new WorkerToolCallScheduler({ maxRunning: 1, maxRunningPerSession: 1,
        queueDepth: 1, queueDepthPerSession: 1, queueTimeoutMs: 30_000, byTool: {} });
    const tool = new WorkerInstanceTool({ instanceName, toolCallHistory: history, toolCallScheduler: scheduler,
        async appendEvent() {}, assertReady() {},
        logStore: { async append() { assert.fail("executor does not log"); }, async read() { return []; } },
        toolInvoker: { async invoke() { assert.fail("must use registered executor"); } },
    });
    const runtime = createToolCallRuntime({ resolveTarget: () => tool.target() });
    let evaluatedResolve!: (value: ApprovalEvaluation) => void;
    let evaluatedReject!: (error: unknown) => void;
    const evaluated = new Promise<ApprovalEvaluation>((resolve, reject) => {
        evaluatedResolve = resolve; evaluatedReject = reject;
    });
    registerApprovalToolCallReview(runtime.hooks, {
        async evaluate(input, signal) {
            const result = service.evaluate(input, signal);
            result.then(evaluatedResolve, evaluatedReject);
            return result;
        },
        getApproval: (id) => service.getApproval(id),
    });
    let effects = 0;
    runtime.hooks.registerExecute("local_effect", async () => { effects++; return { executed: true }; });
    t.after(async () => { service.close(); runtime.close(); await scheduler.close(); });
    return { service, store, events, calls, options, runtime, evaluated,
        effects: () => effects, recoverEvents: () => { failing = false; },
        call: (signal?: AbortSignal) => runtime.api.call(instanceName, "local_effect", {}, {
            source: "mcp", ctxId: "ctx-1", workspace: "/workspace", requestId: "request-1",
        }, signal),
    };
}

for (const decision of ["approve", "deny"] as const) {
    test(`committed ${decision} returns its result through real inbound review despite terminal event EIO`, async (t) => {
        const status = decision === "approve" ? "approved" : "denied";
        const h = fixture(t, `approval.${status}`);
        const outcome = Promise.allSettled([h.call()]);
        const evaluation = await h.evaluated;
        assert.ok(evaluation.decision === "ask");
        assert.equal(h.effects(), 0);
        assert.equal(h.calls.length, 0); // Pending approval precedes target audit admission.
        const result = await h.service.decideApproval("approval-1", { decision, decidedBy: "web" });
        assert.equal(result.status, status);
        assert.equal((await evaluation.awaitDecision).status, status);
        const [call] = await outcome;
        assert.equal(call!.status, decision === "approve" ? "fulfilled" : "rejected");
        assert.equal(h.effects(), decision === "approve" ? 1 : 0);
        assert.equal(h.calls[0]?.status, decision === "approve" ? "completed" : "denied");
        assert.equal(h.calls[0]?.ctxId, "ctx-1");
        assert.equal(h.calls[0]?.requestId, "request-1");
        assert.equal((await h.store.get("approval-1"))?.status, status);
        assert.deepEqual(await h.service.listPendingApprovals(), []);
        await assert.rejects(h.service.decideApproval("approval-1", { decision, decidedBy: "cli" }),
            { code: runtimeErrorCodes.approvalAlreadyDecided });

        h.service.close();
        h.recoverEvents();
        const recovered = new ApprovalService(h.options);
        t.after(() => recovered.close());
        assert.equal((await recovered.getApproval("approval-1")).status, status);
        assert.deepEqual(h.events.map(event => event.type), ["approval.requested", `approval.${status}`]);
        assert.deepEqual(h.events[1]?.data.eventAppendFailure, { code: "EIO", message: "injected event append EIO" });
        await recovered.listApprovals();
        assert.equal(h.events.length, 2);
        assert.equal(h.effects(), decision === "approve" ? 1 : 0);
    });
}

test("requested event EIO retains a live inbound waiter and replays before the approved event", async (t) => {
    const h = fixture(t, "approval.requested");
    let settled = false;
    const outcome = Promise.allSettled([h.call()]).then(result => { settled = true; return result; });
    const evaluation = await h.evaluated;
    assert.ok(evaluation.decision === "ask");
    assert.equal(settled, false);
    assert.equal(h.effects(), 0);
    assert.equal(h.calls.length, 0);
    const [pending] = await h.service.listPendingApprovals("ctx-1");
    assert.equal(pending?.approvalId, "approval-1");
    assert.equal(pending?.workspace, "/workspace");
    h.recoverEvents();
    assert.equal((await h.service.decideApproval("approval-1", { decision: "approve", decidedBy: "web" })).status, "approved");
    assert.equal((await outcome)[0]?.status, "fulfilled");
    assert.equal(h.effects(), 1);
    assert.equal(h.calls[0]?.status, "completed");
    assert.deepEqual(h.events.map(event => event.type), ["approval.requested", "approval.approved"]);
    assert.deepEqual(h.events[0]?.data.eventAppendFailure, { code: "EIO", message: "injected event append EIO" });
    assert.deepEqual(await h.service.listPendingApprovals(), []);
    await h.service.listApprovals();
    assert.equal(h.events.length, 2);
});

test("abort with an undelivered requested event terminalizes the live call and replays cancellation", async (t) => {
    const h = fixture(t, "approval.requested");
    const controller = new AbortController();
    const outcome = Promise.allSettled([h.call(controller.signal)]);
    const evaluation = await h.evaluated;
    assert.ok(evaluation.decision === "ask");
    controller.abort("caller left");
    assert.equal((await evaluation.awaitDecision).status, "cancelled");
    assert.equal((await outcome)[0]?.status, "rejected");
    assert.equal(h.effects(), 0);
    assert.deepEqual(await h.service.listPendingApprovals(), []);
    assert.equal((await h.service.getApproval("approval-1")).status, "cancelled");
    h.recoverEvents();
    await h.service.listApprovals();
    assert.deepEqual(h.events.map(event => event.type), ["approval.requested", "approval.cancelled"]);
    assert.equal(h.events[1]?.data.reason, "caller left");
    await assert.rejects(h.service.decideApproval("approval-1", { decision: "approve", decidedBy: "web" }),
        { code: runtimeErrorCodes.approvalAlreadyDecided });
});

test("startup cancels an abandoned waiter while preserving its requested-event failure diagnostic", async (t) => {
    const h = fixture(t, "approval.requested");
    const outcome = Promise.allSettled([h.call()]);
    const evaluation = await h.evaluated;
    assert.ok(evaluation.decision === "ask");
    h.service.close();
    assert.equal((await outcome)[0]?.status, "rejected");
    h.recoverEvents();
    const recovered = new ApprovalService(h.options);
    t.after(() => recovered.close());
    assert.equal((await recovered.getApproval("approval-1")).status, "cancelled");
    assert.deepEqual(await recovered.listPendingApprovals(), []);
    assert.deepEqual(h.events.map(event => event.type), ["approval.requested", "approval.cancelled"]);
    assert.deepEqual(h.events[0]?.data.eventAppendFailure, { code: "EIO", message: "injected event append EIO" });
    assert.equal(h.effects(), 0);
});

test("failure before the decision commit leaves the original approval actionable without granting execution", async (t) => {
    const h = fixture(t, "none");
    const outcome = Promise.allSettled([h.call()]);
    const evaluation = await h.evaluated;
    assert.ok(evaluation.decision === "ask");
    const fault = t.mock.method(h.store, "append", async () => {
        throw Object.assign(new Error("decision write EIO"), { code: "EIO" });
    });
    await assert.rejects(h.service.decideApproval("approval-1", { decision: "approve", decidedBy: "web" }),
        { code: "EIO", message: "decision write EIO" });
    assert.equal((await h.store.get("approval-1"))?.status, "pending");
    assert.equal((await h.service.listPendingApprovals()).length, 1);
    assert.equal(h.effects(), 0);
    assert.deepEqual(h.events.map(event => event.type), ["approval.requested"]);
    fault.mock.restore();
    assert.equal((await h.service.decideApproval("approval-1", { decision: "approve", decidedBy: "web" })).status, "approved");
    assert.equal((await outcome)[0]?.status, "fulfilled");
    assert.equal(h.effects(), 1);
});

test("event failures survive retention until diagnostic replay succeeds", async (t) => {
    const h = fixture(t, "approval.approved");
    const outcome = Promise.allSettled([h.call()]);
    await h.evaluated;
    await h.service.decideApproval("approval-1", { decision: "approve", decidedBy: "web" });
    assert.equal((await outcome)[0]?.status, "fulfilled");
    h.service.close();
    const recovered = new ApprovalService({ ...h.options, now: () => 31 * 24 * 60 * 60 * 1000 });
    t.after(() => recovered.close());
    assert.equal((await recovered.listApprovals())[0]?.status, "approved");
    assert.equal((await h.store.get("approval-1"))?.status, "approved");
    h.recoverEvents();
    assert.deepEqual(await recovered.listApprovals(), []);
    assert.equal(h.events[1]?.type, "approval.approved");
    assert.deepEqual(h.events[1]?.data.eventAppendFailure, { code: "EIO", message: "injected event append EIO" });
    assert.equal(await h.store.get("approval-1"), undefined);
    assert.equal(h.effects(), 1);
});

test("failed event acknowledgement preserves the committed result and retries delivery at least once", async (t) => {
    const h = fixture(t, "none");
    const outcome = Promise.allSettled([h.call()]);
    await h.evaluated;
    const append = h.store.append.bind(h.store);
    const fault = t.mock.method(h.store, "append", async (request: ApprovalRecord) => {
        if (request.eventOutbox === undefined) throw new Error("acknowledgement EIO");
        await append(request);
    });
    const warning = t.mock.method(console, "warn", () => {});
    assert.equal((await h.service.decideApproval("approval-1", { decision: "approve", decidedBy: "web" })).status, "approved");
    assert.equal((await outcome)[0]?.status, "fulfilled");
    assert.equal(h.effects(), 1);
    assert.equal(warning.mock.callCount(), 1);
    assert.match(String(warning.mock.calls[0]?.arguments[1]), /acknowledgement EIO/);
    assert.equal((await h.store.get("approval-1"))?.eventOutbox?.[0]?.type, "approval.approved");
    fault.mock.restore();
    await h.service.listApprovals();
    assert.deepEqual(h.events.map(event => event.type), ["approval.requested", "approval.approved", "approval.approved"]);
    assert.equal((await h.store.get("approval-1"))?.eventOutbox, undefined);
    assert.equal(h.effects(), 1);
});

test("retention failure after committing a decision cannot turn success into failure", async (t) => {
    const h = fixture(t, "none");
    const outcome = Promise.allSettled([h.call()]);
    await h.evaluated;
    const fault = t.mock.method(h.store, "list", async () => { throw new Error("retention EIO"); });
    const warning = t.mock.method(console, "warn", () => {});
    assert.equal((await h.service.decideApproval("approval-1", { decision: "approve", decidedBy: "web" })).status, "approved");
    assert.equal((await outcome)[0]?.status, "fulfilled");
    assert.equal((await h.store.get("approval-1"))?.status, "approved");
    assert.equal(warning.mock.callCount(), 1);
    assert.match(String(warning.mock.calls[0]?.arguments[1]), /retention EIO/);
    fault.mock.restore();
    assert.equal((await h.service.listApprovals())[0]?.status, "approved");
    assert.equal(h.effects(), 1);
});

test("requested event EIO preserves real MCP Context and workspace authorization for approval actions", async (t) => {
    const h = fixture(t, "approval.requested");
    const outcome = Promise.allSettled([h.call()]);
    await h.evaluated;
    let actions = 0;
    h.runtime.hooks.registerExecute("mcpapp_action", async () => {
        actions++;
        const result = await h.service.decideApproval("approval-1", { decision: "approve", decidedBy: "web" });
        return { status: result.status };
    });
    const action = (ctxId: string, workspace: string) => h.runtime.api.call(h.options.instanceName, "mcpapp_action", {
        itemId: "approval-1", actionId: "approve",
    }, { source: "mcp", ctxId, workspace });
    await assert.rejects(action("other-context", "/workspace"), { code: runtimeErrorCodes.toolCallRejected });
    await assert.rejects(action("ctx-1", "/other-workspace"), { code: runtimeErrorCodes.toolCallRejected });
    assert.equal(actions, 0);
    assert.equal(h.effects(), 0);
    assert.equal((await h.service.listPendingApprovals()).length, 1);
    assert.deepEqual(await action("ctx-1", "/workspace"), { status: "approved" });
    assert.equal((await outcome)[0]?.status, "fulfilled");
    assert.equal(actions, 1);
    assert.equal(h.effects(), 1);
    assert.equal((await h.store.list()).length, 1);
    assert.deepEqual(await h.service.listPendingApprovals(), []);
    h.recoverEvents();
    await h.service.listApprovals();
    assert.deepEqual(h.events.map(event => event.type), ["approval.requested", "approval.approved"]);
});
