import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName, type ApprovalRequest } from "@portable-devshell/shared";
import { ApprovalManager, ApprovalStore } from "@portable-devshell/core/testing";

test("ApprovalManager retries a failed durable expiry instead of leaving a dead pending approval", async () => {
    const records: ApprovalRequest[] = [];
    let failExpiryOnce = true;
    const store = new ApprovalStore({
        async append(request: ApprovalRequest) {
            if (request.status === "expired" && failExpiryOnce) {
                failExpiryOnce = false;
                throw new Error("approval store unavailable");
            }
            records.push(structuredClone(request));
        },
        async readAll() {
            return records.map((request) => structuredClone(request));
        },
    } as never);
    const manager = new ApprovalManager({
        instanceName: asInstanceName("approval-retry"),
        policy: { mode: "ask" },
        store,
        timeout: { ms: 5 },
    });

    const evaluation = await manager.evaluate({
        callId: "call-1",
        context: { source: "cli", workspace: "/workspace" },
        inputSummary: "{}",
        toolName: "bash_run",
    });
    assert.equal(evaluation.decision, "ask");
    if (evaluation.decision !== "ask") throw new Error("approval was not requested");

    const resolution = await evaluation.awaitDecision;
    assert.equal(resolution.status, "expired");
    assert.equal(failExpiryOnce, false);
    assert.equal((await manager.getApproval(evaluation.request.approvalId)).status, "expired");
});

test("ApprovalManager retries restart reconciliation after a transient store failure", async () => {
    const records: ApprovalRequest[] = [];
    let reads = 0;
    const store = new ApprovalStore({
        async append(request: ApprovalRequest) {
            records.push(structuredClone(request));
        },
        async readAll() {
            reads += 1;
            if (reads === 1) throw new Error("temporary approval store failure");
            return records.map((request) => structuredClone(request));
        },
    } as never);
    const manager = new ApprovalManager({
        instanceName: asInstanceName("approval-retry-startup"),
        policy: { mode: "allow" },
        store,
    });

    await assert.rejects(manager.listApprovals(), /temporary approval store failure/u);
    await assert.doesNotReject(manager.listApprovals());
    assert.equal(reads, 3);
});

test("ApprovalManager reconciles persisted pending approvals after restart", async () => {
    const now = Date.now();
    const records: ApprovalRequest[] = [
        {
            approvalId: "approval-expired",
            callId: "call-expired",
            createdAt: new Date(now - 10_000).toISOString(),
            expiresAt: new Date(now - 1_000).toISOString(),
            inputSummary: "{}",
            instance: asInstanceName("approval-restart"),
            reason: "Approval required.",
            riskLevel: "medium",
            source: "mcp",
            status: "pending",
            toolName: "bash_run",
        },
        {
            approvalId: "approval-orphaned",
            callId: "call-orphaned",
            createdAt: new Date(now - 1_000).toISOString(),
            expiresAt: new Date(now + 60_000).toISOString(),
            inputSummary: "{}",
            instance: asInstanceName("approval-restart"),
            reason: "Approval required.",
            riskLevel: "medium",
            source: "mcp",
            status: "pending",
            toolName: "bash_run",
        },
    ];
    const store = new ApprovalStore({
        async append(request: ApprovalRequest) {
            records.push(structuredClone(request));
        },
        async readAll() {
            return records.map((request) => structuredClone(request));
        },
    } as never);
    const manager = new ApprovalManager({
        instanceName: asInstanceName("approval-restart"),
        policy: { mode: "ask" },
        store,
    });

    const approvals = await manager.listApprovals();
    assert.equal(approvals.find((entry) => entry.approvalId === "approval-expired")?.status, "expired");
    assert.equal(approvals.find((entry) => entry.approvalId === "approval-orphaned")?.status, "cancelled");
    await assert.rejects(
        manager.decideApproval("approval-orphaned", { decision: "approve", decidedBy: "web" }),
        /already decided/u,
    );
});

test("ApprovalManager serializes concurrent decisions for the same approval", async () => {
    const records: ApprovalRequest[] = [];
    const store = new ApprovalStore({
        async append(request: ApprovalRequest) {
            if (request.status !== "pending") await new Promise<void>((resolve) => setImmediate(resolve));
            records.push(structuredClone(request));
        },
        async readAll() {
            return records.map((request) => structuredClone(request));
        },
    } as never);
    const manager = new ApprovalManager({
        instanceName: asInstanceName("approval-concurrent-decision"),
        policy: { mode: "ask" },
        store,
        timeout: { ms: 60_000 },
    });
    const evaluation = await manager.evaluate({
        callId: "call-concurrent",
        context: { ctxId: "ctx-concurrent", source: "mcp" },
        inputSummary: "{}",
        toolName: "bash_run",
    });
    assert.equal(evaluation.decision, "ask");
    if (evaluation.decision !== "ask") throw new Error("approval was not requested");

    const decisions = await Promise.allSettled([
        manager.decideApproval(evaluation.request.approvalId, { decision: "approve", decidedBy: "web" }),
        manager.decideApproval(evaluation.request.approvalId, { decision: "deny", decidedBy: "web" }),
    ]);
    assert.equal(decisions.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(decisions.filter((result) => result.status === "rejected").length, 1);

    const resolution = await evaluation.awaitDecision;
    const persisted = await manager.getApproval(evaluation.request.approvalId);
    assert.equal(persisted.status, resolution.status);
});

test("ApprovalManager serializes a decision racing its expiry timer", async () => {
    const records: ApprovalRequest[] = [];
    const store = new ApprovalStore({
        async append(request: ApprovalRequest) {
            if (request.status === "approved") await new Promise<void>((resolve) => setTimeout(resolve, 20));
            records.push(structuredClone(request));
        },
        async readAll() {
            return records.map((request) => structuredClone(request));
        },
    } as never);
    const manager = new ApprovalManager({
        instanceName: asInstanceName("approval-decision-expiry-race"),
        policy: { mode: "ask" },
        store,
        timeout: { ms: 5 },
    });
    const evaluation = await manager.evaluate({
        callId: "call-expiry-race",
        context: { ctxId: "ctx-expiry-race", source: "mcp" },
        inputSummary: "{}",
        toolName: "bash_run",
    });
    assert.equal(evaluation.decision, "ask");
    if (evaluation.decision !== "ask") throw new Error("approval was not requested");

    const decided = manager.decideApproval(
        evaluation.request.approvalId,
        { decision: "approve", decidedBy: "web" },
    );
    const [decision, resolution] = await Promise.all([decided, evaluation.awaitDecision]);
    assert.equal(decision.status, "approved");
    assert.equal(resolution.status, "approved");
    assert.equal((await manager.getApproval(evaluation.request.approvalId)).status, "approved");
    assert.equal(records.filter((request) => request.status === "expired").length, 0);
});
