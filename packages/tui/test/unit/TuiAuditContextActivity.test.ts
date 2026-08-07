import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    type ApprovalRequest,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import { TuiAppStore } from "../../src/state/TuiAppStore.js";
import { latestObservedContextId } from "../../src/state/audit/TuiAuditContextActivity.js";

test("latest observed Context follows call start order instead of completion order", () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({
        instanceState: {
            alpha: { toolCalls: [
                toolCall({
                    callId: "old-slow",
                    completedAt: "2026-08-07T00:10:00.000Z",
                    ctxId: "ctx-old",
                    startedAt: "2026-08-07T00:00:00.000Z",
                }),
                toolCall({
                    callId: "new-fast",
                    completedAt: "2026-08-07T00:06:00.000Z",
                    ctxId: "ctx-new",
                    startedAt: "2026-08-07T00:05:00.000Z",
                }),
                ],
            },
        },
    });

    assert.equal(latestObservedContextId(store.getState(), "alpha"), "ctx-new");
});

test("latest observed Context includes a newer pending approval before its tool call starts", () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({
        instanceState: {
            alpha: {
                approvals: [approval("approval-new", "ctx-new", "2026-08-07T00:05:00.000Z")],
                toolCalls: [
                toolCall({
                    callId: "old-call",
                    completedAt: "2026-08-07T00:04:00.000Z",
                    ctxId: "ctx-old",
                    startedAt: "2026-08-07T00:00:00.000Z",
                }),
            ] },
        },
    });

    assert.equal(latestObservedContextId(store.getState(), "alpha"), "ctx-new");
});

function toolCall(input: {
    callId: string;
    completedAt: string;
    ctxId: string;
    startedAt: string;
}): ToolCallRecord {
    return {
        callId: input.callId,
        completedAt: input.completedAt,
        ctxId: input.ctxId,
        inputSummary: "{}",
        instance: asInstanceName("alpha"),
        output: {},
        source: "mcp",
        startedAt: input.startedAt,
        status: "completed",
        toolName: "bash_run",
    };
}

function approval(
    approvalId: string,
    ctxId: string,
    createdAt: string,
): ApprovalRequest {
    return {
        approvalId,
        callId: `${approvalId}-call`,
        createdAt,
        ctxId,
        expiresAt: "2026-08-07T01:00:00.000Z",
        inputSummary: "{}",
        instance: asInstanceName("alpha"),
        reason: "test",
        riskLevel: "low",
        source: "mcp",
        status: "pending",
        toolName: "bash_run",
    };
}
