import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    errorCodes,
    type ApprovalRequest,
    type JsonValue,
} from "@portable-devshell/shared";

import {
    ApprovalService,
    type ApprovalStorePort,
    type ApprovalEventPort,
} from "../../../../src/control/approval/Service.js";

class MemoryStore implements ApprovalStorePort {
    readonly records = new Map<string, ApprovalRequest>();

    async append(request: ApprovalRequest): Promise<void> {
        this.records.set(request.approvalId, request);
    }

    async get(approvalId: string): Promise<ApprovalRequest | undefined> {
        return this.records.get(approvalId);
    }

    async delete(approvalId: string): Promise<void> {
        this.records.delete(approvalId);
    }

    async list(): Promise<ApprovalRequest[]> {
        return [...this.records.values()];
    }
}

class MemoryEvents implements ApprovalEventPort {
    readonly records: { type: string; data: Record<string, JsonValue> }[] = [];

    constructor(readonly store: MemoryStore) {}

    async append(type: Parameters<ApprovalEventPort["append"]>[0], data: Record<string, JsonValue>): Promise<void> {
        const persisted = await this.store.get(String(data.approvalId));
        assert.equal(persisted?.status, data.status);
        assert.equal(persisted?.callId, data.callId);
        this.records.push({ type, data });
    }
}

const input = {
    callId: "call-1",
    source: "cli" as const,
    inputSummary: "{}",
    toolName: "shell",
};

function fixture() {
    const store = new MemoryStore();
    const events = new MemoryEvents(store);
    const service = new ApprovalService({
        instanceName: asInstanceName("dev"),
        store,
        events,
        policy: { mode: "ask" },
        timeout: { ms: 100 },
        now: () => 0,
        createId: () => "approval-1",
    });
    return { service, store, events };
}

test("approval service persists requests and resolves decisions", async () => {
    const store = new MemoryStore();
    const service = new ApprovalService({
        instanceName: asInstanceName("dev"),
        store,
        events: new MemoryEvents(store),
        policy: { mode: "ask" },
        now: () => 0,
        createId: () => "approval-1",
    });
    const result = await service.evaluate({
        callId: "call-1",
        source: "cli",
        inputSummary: "{}",
        toolName: "shell",
    });

    assert.equal(result.decision, "ask");
    assert.ok(result.decision === "ask");
    assert.equal((await service.listApprovals()).length, 1);

    const updated = await service.decideApproval(result.request.approvalId, {
        decision: "approve",
        decidedBy: "cli",
    });
    assert.equal(updated.status, "approved");
    assert.deepEqual(await result.awaitDecision, {
        decision: updated.decision,
        status: "approved",
    });
});

test("retiring an instance cancels pending approvals", async () => {
    const store = new MemoryStore();
    const service = new ApprovalService({
        instanceName: asInstanceName("dev"),
        store,
        events: new MemoryEvents(store),
        policy: { mode: "ask" },
        createId: () => "approval-2",
    });
    const result = await service.evaluate({
        callId: "call-2",
        source: "cli",
        inputSummary: "{}",
        toolName: "shell",
    });

    assert.equal(result.decision, "ask");
    assert.ok(result.decision === "ask");
    await service.retire("instance disabled");

    assert.equal((await service.getApproval("approval-2")).status, "cancelled");
    assert.equal((await result.awaitDecision).status, "cancelled");
});

for (const decision of ["approve", "deny"] as const) {
    test(`${decision} emits requested and one persisted terminal event`, async (t) => {
        const { service, events } = fixture();
        t.after(() => service.close());
        const result = await service.evaluate({
            ...input, source: "mcp", requestId: "request-1", ctxId: "ctx-1",
            workspace: "/workspace", recording: "caller",
        });
        assert.ok(result.decision === "ask");
        assert.equal(events.records.length, 1);
        assert.deepEqual(events.records[0], {
            type: "approval.requested",
            data: {
                approvalId: "approval-1", callId: "call-1",
                createdAt: new Date(0).toISOString(), expiresAt: new Date(100).toISOString(),
                inputSummary: "{}", reason: "Approval required before running shell.",
                recording: "caller", requestId: "request-1", ctxId: "ctx-1",
                riskLevel: "medium", source: "mcp", status: "pending",
                toolName: "shell", workspace: "/workspace",
            },
        });
        const updated = await service.decideApproval("approval-1", {
            decision, decidedBy: "web", reason: "reviewed", remember: false,
        });
        const resolution = await result.awaitDecision;
        assert.equal(resolution.status, updated.status);
        assert.equal(updated.terminalAt, new Date(0).toISOString());
        assert.equal(events.records.length, 2);
        assert.deepEqual(events.records[1], {
            type: `approval.${updated.status}`,
            data: {
                ...events.records[0].data,
                status: updated.status, decision, decidedBy: "web",
                decidedAt: new Date(0).toISOString(), reason: "reviewed", remember: false,
                terminalAt: new Date(0).toISOString(),
            },
        });
        await service.cancel("approval-1", "late cancellation");
        await assert.rejects(service.decideApproval("approval-1", {
            decision, decidedBy: "cli",
        }), { code: errorCodes.coreApprovalAlreadyDecided });
        assert.equal(events.records.length, 2);
        assert.deepEqual(await service.listPendingApprovals(), []);
    });
}

for (const preAborted of [false, true]) {
    test(`service owns abort cancellation (pre-aborted=${preAborted})`, async (t) => {
        const { service, events, store } = fixture();
        t.after(() => service.close());
        const controller = new AbortController();
        const signal = preAborted ? AbortSignal.abort(new Error("caller stopped")) : controller.signal;
        const result = await service.evaluate(input, signal);
        assert.ok(result.decision === "ask");
        controller.abort(new Error("caller stopped"));
        const resolution = await result.awaitDecision;
        assert.equal(resolution.status, "cancelled");
        assert.ok(resolution.status === "cancelled");
        assert.deepEqual(resolution.error.details, {
            instance: "dev", toolName: "shell", reason: "caller stopped",
        });
        assert.equal((await store.get("approval-1"))?.status, "cancelled");
        assert.equal((await store.get("approval-1"))?.terminalAt, new Date(0).toISOString());
        assert.deepEqual(events.records.map(({ type }) => type), [
            "approval.requested", "approval.cancelled",
        ]);
        assert.equal(events.records[1].data.reason, "caller stopped");
        assert.equal(events.records[1].data.status, "cancelled");
        await service.cancel("approval-1");
        assert.equal(events.records.length, 2);
    });
}

test("expiration emits once after persistence and ignores subsequent abort", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { service, events } = fixture();
    t.after(() => service.close());
    const controller = new AbortController();
    const result = await service.evaluate(input, controller.signal);
    assert.ok(result.decision === "ask");
    t.mock.timers.tick(100);
    assert.equal((await result.awaitDecision).status, "expired");
    assert.equal((await service.getApproval("approval-1")).terminalAt, new Date(100).toISOString());
    controller.abort("too late");
    await service.cancel("approval-1");
    assert.deepEqual(events.records.map(({ type }) => type), [
        "approval.requested", "approval.expired",
    ]);
    assert.equal(events.records[1].data.status, "expired");
});

test("persisting approve wins a concurrent abort and timeout without duplicate events", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { service, events, store } = fixture();
    t.after(() => service.close());
    const controller = new AbortController();
    const result = await service.evaluate(input, controller.signal);
    assert.ok(result.decision === "ask");
    let started!: () => void;
    const persisting = new Promise<void>((done) => { started = done; });
    let release!: () => void;
    const barrier = new Promise<void>((done) => { release = done; });
    t.mock.method(store, "append", async (request: ApprovalRequest) => {
        assert.equal(request.status, "approved");
        started();
        await barrier;
        store.records.set(request.approvalId, request);
    });
    const decision = service.decideApproval("approval-1", { decision: "approve", decidedBy: "cli" });
    await persisting;
    controller.abort("racing abort");
    t.mock.timers.tick(100);
    release();
    await decision;
    assert.equal((await result.awaitDecision).status, "approved");
    await service.cancel("approval-1");
    assert.deepEqual(events.records.map(({ type }) => type), [
        "approval.requested", "approval.approved",
    ]);
});

test("queued abort wins a concurrent decision without duplicate events", async (t) => {
    const { service, events } = fixture();
    t.after(() => service.close());
    const controller = new AbortController();
    const result = await service.evaluate(input, controller.signal);
    assert.ok(result.decision === "ask");
    controller.abort("racing abort");
    await assert.rejects(service.decideApproval("approval-1", {
        decision: "deny", decidedBy: "cli",
    }), { code: errorCodes.coreApprovalAlreadyDecided });
    assert.equal((await result.awaitDecision).status, "cancelled");
    assert.deepEqual(events.records.map(({ type }) => type), [
        "approval.requested", "approval.cancelled",
    ]);
});

for (const mode of ["disabled", "allow", "deny"] as const) {
    test(`policy ${mode} creates neither requests nor events`, async (t) => {
        const { service, events, store } = fixture();
        t.after(() => service.close());
        service.setPolicy({ mode });
        const evaluation = await service.evaluate(input);
        assert.equal(evaluation.decision, mode === "deny" ? "deny" : "allow");
        assert.deepEqual(await store.list(), []);
        assert.deepEqual(events.records, []);
    });
}

test("required approval and source-specific rules preserve policy evaluation", async (t) => {
    const { service, events } = fixture();
    t.after(() => service.close());
    service.setPolicy({ mode: "allow", rules: [
        { match: "exact", source: "mcp", toolName: "shell", decision: "deny" },
    ] });
    assert.equal((await service.evaluate({ ...input, source: "mcp", required: true })).decision, "deny");
    const result = await service.evaluate({ ...input, required: true });
    assert.ok(result.decision === "ask");
    await service.retire("instance disabled");
    assert.equal((await result.awaitDecision).status, "cancelled");
    assert.equal(events.records[1].data.reason, "instance disabled");
});

for (const status of ["cancelled", "expired"] as const) {
    test(`recovery durably writes and emits ${status} once`, async () => {
        const { service, events, store } = fixture();
        await service.evaluate(input);
        service.close();
        const recovered = new ApprovalService({
            instanceName: asInstanceName("dev"), store, events,
            now: () => status === "expired" ? 100 : 0,
        });
        assert.equal((await recovered.getApproval("approval-1")).status, status);
        assert.equal((await recovered.getApproval("approval-1")).terminalAt,
            new Date(status === "expired" ? 100 : 0).toISOString());
        assert.equal((await recovered.getApproval("approval-1")).status, status);
        assert.deepEqual(events.records.map(({ type }) => type), [
            "approval.requested", `approval.${status}`,
        ]);
        recovered.close();
    });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function retentionFixture() {
    let now = 60 * DAY_MS;
    const store = new MemoryStore();
    const events = new MemoryEvents(store);
    const service = new ApprovalService({
        instanceName: asInstanceName("dev"), store, events,
        policy: { mode: "ask" },
        now: () => now,
        createId: () => "live-pending",
    });
    return { service, store, events, setNow: (value: number) => { now = value; } };
}

function retainedRequest(approvalId: string, fields: Partial<ApprovalRequest> = {}): ApprovalRequest {
    return {
        ...input,
        approvalId,
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(DAY_MS).toISOString(),
        instance: asInstanceName("dev"),
        reason: "review required",
        riskLevel: "medium",
        status: "approved",
        ...fields,
    };
}

test("age pruning preserves an old live pending approval and the exact age boundary", async (t) => {
    const { service, store, events, setNow } = retentionFixture();
    t.after(() => service.close());
    setNow(0);
    const pending = await service.evaluate(input);
    assert.ok(pending.decision === "ask");
    setNow(60 * DAY_MS);
    await store.append(retainedRequest("old-terminal", { terminalAt: new Date(29 * DAY_MS).toISOString() }));
    await store.append(retainedRequest("age-boundary", { terminalAt: new Date(30 * DAY_MS).toISOString() }));

    assert.deepEqual((await service.listApprovals()).map(({ approvalId }) => approvalId), [
        "live-pending", "age-boundary",
    ]);
    assert.equal((await store.get("live-pending"))?.status, "pending");
    assert.equal(events.records.length, 1);
});

test("count pruning retains the newest 1000 terminals and pending with deterministic ties", async (t) => {
    const { service, store } = retentionFixture();
    t.after(() => service.close());
    await service.evaluate(input);
    for (let index = 1001; index >= 0; index -= 1) {
        await store.append(retainedRequest(`terminal-${String(index).padStart(4, "0")}`, {
            terminalAt: new Date((59 * DAY_MS) + Math.floor(index / 2)).toISOString(),
        }));
    }

    const approvals = await service.listApprovals();
    assert.equal(approvals.length, 1001);
    assert.equal((await store.get("live-pending"))?.status, "pending");
    assert.deepEqual(approvals.filter(({ status }) => status !== "pending")
        .map(({ approvalId }) => approvalId).sort(),
    Array.from({ length: 1000 }, (_, index) => `terminal-${String(index + 2).padStart(4, "0")}`));
});

test("pruning uses terminalAt, decision time, expired deadline, then creation time", async (t) => {
    const { service, store } = retentionFixture();
    t.after(() => service.close());
    const recent = new Date(59 * DAY_MS).toISOString();
    await store.append(retainedRequest("terminal-time", {
        terminalAt: recent,
        decision: { approvalId: "terminal-time", decidedAt: new Date(0).toISOString(), decidedBy: "cli", decision: "approve" },
    }));
    await store.append(retainedRequest("decision-time", {
        decision: { approvalId: "decision-time", decidedAt: recent, decidedBy: "cli", decision: "approve" },
    }));
    await store.append(retainedRequest("expiry-time", { status: "expired", expiresAt: recent }));
    await store.append(retainedRequest("creation-time", { status: "cancelled", createdAt: recent }));
    await store.append(retainedRequest("old-decision", {
        createdAt: recent,
        decision: { approvalId: "old-decision", decidedAt: new Date(0).toISOString(), decidedBy: "cli", decision: "approve" },
    }));
    await store.append(retainedRequest("old-expiry", { status: "expired", createdAt: recent }));
    await store.append(retainedRequest("old-creation", { status: "cancelled" }));

    assert.deepEqual((await service.listApprovals()).map(({ approvalId }) => approvalId), [
        "terminal-time", "decision-time", "expiry-time", "creation-time",
    ]);
});

test("startup recovery prunes old terminals and timestamps recovered pending before pruning", async (t) => {
    const { service, store, events } = retentionFixture();
    t.after(() => service.close());
    await store.append(retainedRequest("old-terminal"));
    await store.append(retainedRequest("old-expired-pending", { status: "pending" }));
    await store.append(retainedRequest("recent-expired-pending", {
        status: "pending", expiresAt: new Date(59 * DAY_MS).toISOString(),
    }));
    await store.append(retainedRequest("future-pending", {
        status: "pending", expiresAt: new Date(61 * DAY_MS).toISOString(),
    }));

    const approvals = await service.listApprovals();
    assert.deepEqual(approvals.map(({ approvalId, status, terminalAt }) => ({ approvalId, status, terminalAt })), [
        { approvalId: "recent-expired-pending", status: "expired", terminalAt: new Date(59 * DAY_MS).toISOString() },
        { approvalId: "future-pending", status: "cancelled", terminalAt: new Date(60 * DAY_MS).toISOString() },
    ]);
    assert.deepEqual(events.records.map(({ type, data }) => [type, data.approvalId]), [
        ["approval.expired", "old-expired-pending"],
        ["approval.expired", "recent-expired-pending"],
        ["approval.cancelled", "future-pending"],
    ]);
    assert.deepEqual(await service.listPendingApprovals(), []);
});

test("listApprovals lazily removes terminals as the clock advances", async (t) => {
    const { service, setNow, events } = retentionFixture();
    t.after(() => service.close());
    await service.evaluate(input);
    const approved = await service.decideApproval("live-pending", { decision: "approve", decidedBy: "cli" });
    assert.equal(approved.terminalAt, new Date(60 * DAY_MS).toISOString());
    assert.equal((await service.listApprovals()).length, 1);
    setNow(90 * DAY_MS + 1);
    assert.deepEqual(await service.listApprovals(), []);
    assert.equal(events.records.length, 2);
});

test("terminal transitions enforce both retention bounds", async (t) => {
    const { service, store } = retentionFixture();
    t.after(() => service.close());
    await service.evaluate(input);
    await store.append(retainedRequest("old-terminal"));
    for (let index = 0; index < 1000; index += 1) {
        await store.append(retainedRequest(`terminal-${String(index).padStart(4, "0")}`, {
            terminalAt: new Date(59 * DAY_MS + index).toISOString(),
        }));
    }

    await service.cancel("live-pending");
    assert.equal(await store.get("old-terminal"), undefined);
    assert.equal(await store.get("terminal-0000"), undefined);
    assert.equal((await store.list()).length, 1000);
    assert.equal((await store.get("live-pending"))?.terminalAt, new Date(60 * DAY_MS).toISOString());
});
