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
