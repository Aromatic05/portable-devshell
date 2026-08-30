import assert from "node:assert/strict";
import test from "node:test";

import {
    ApprovalManager,
    ApprovalStore,
    AuditToolCallHistory,
} from "@portable-devshell/core/testing";
import {
    asInstanceName,
    type ApprovalRequest,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import { WorkerInstanceToolApproval } from "../../src/worker/instance/tool/WorkerInstanceToolApproval.ts";

test("WorkerInstanceToolApproval cancels a durable pending approval when setup fails", async () => {
    const approvalRecords: ApprovalRequest[] = [];
    const toolCallRecords: ToolCallRecord[] = [];
    const instanceName = asInstanceName("approval-setup-failure");
    const manager = new ApprovalManager({
        instanceName,
        policy: { mode: "ask" },
        store: new ApprovalStore({
            async append(request: ApprovalRequest) {
                approvalRecords.push(structuredClone(request));
            },
            async readAll() {
                return approvalRecords.map((request) =>
                    structuredClone(request),
                );
            },
        }),
        timeout: { ms: 60_000 },
    });
    const history = new AuditToolCallHistory(instanceName, {
        async append(record: ToolCallRecord) {
            toolCallRecords.push(structuredClone(record));
        },
        async readAll() {
            return toolCallRecords.map((record) => structuredClone(record));
        },
    });
    const callId = "call-setup-failure";
    const context = { ctxId: "ctx-setup-failure", source: "mcp" as const };
    const startedAt = new Date().toISOString();
    await history.started(
        callId,
        "bash_run",
        "{}",
        context,
        startedAt,
        "queued",
    );

    const approval = new WorkerInstanceToolApproval({
        approvalManager: manager,
        async appendEvent(type) {
            if (type === "approval.requested")
                throw new Error("event store unavailable");
        },
        toolCallHistory: history,
    });
    let markedPending = false;

    await assert.rejects(
        approval.prepare(callId, "bash_run", "{}", context, startedAt, () => {
            markedPending = true;
        }),
        /event store unavailable/u,
    );
    assert.equal(markedPending, true);
    const approvals = await manager.listApprovals();
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.status, "cancelled");
});
