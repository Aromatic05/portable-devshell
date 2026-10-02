import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    type ApprovalRequest,
} from "@portable-devshell/shared";

import {
    ApprovalService,
    type ApprovalStorePort,
} from "../../../../src/control/approval/Service.js";

class MemoryStore implements ApprovalStorePort {
    readonly records = new Map<string, ApprovalRequest>();

    async append(request: ApprovalRequest): Promise<void> {
        this.records.set(request.approvalId, request);
    }

    async get(approvalId: string): Promise<ApprovalRequest | undefined> {
        return this.records.get(approvalId);
    }

    async list(): Promise<ApprovalRequest[]> {
        return [...this.records.values()];
    }
}

const context = { source: "cli" as const };

test("approval service persists requests and resolves decisions", async () => {
    const store = new MemoryStore();
    const service = new ApprovalService({
        instanceName: asInstanceName("dev"),
        store,
        policy: { mode: "ask" },
        now: () => 0,
        createId: () => "approval-1",
    });
    const result = await service.evaluate({
        callId: "call-1",
        context,
        inputSummary: "{}",
        toolName: "shell",
    });

    assert.equal(result.decision, "ask");
    if (result.decision !== "ask") throw new Error("expected approval request");
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
    const service = new ApprovalService({
        instanceName: asInstanceName("dev"),
        store: new MemoryStore(),
        policy: { mode: "ask" },
        createId: () => "approval-2",
    });
    const result = await service.evaluate({
        callId: "call-2",
        context,
        inputSummary: "{}",
        toolName: "shell",
    });

    assert.equal(result.decision, "ask");
    if (result.decision !== "ask") throw new Error("expected approval request");
    await service.retire("instance disabled");

    assert.equal((await service.getApproval("approval-2")).status, "cancelled");
    assert.equal((await result.awaitDecision).status, "cancelled");
});
