import assert from "node:assert/strict";
import { createAuditRuntime } from "../../../src/audit/index.ts";
import { registerApprovalToolCallReview } from "../../../src/approval/execution/ToolCallReview.ts";
import { barrier, round4Target } from "./Round4Harness.ts";

export async function durableCalls(h: Awaited<ReturnType<typeof round4Target>>) {
    const reader = createAuditRuntime({ instanceName: h.instanceName, filePath: h.databasePath, eventBufferSize: 100 });
    try { return reader.api.toolCalls.readQuery(); }
    finally { await reader.close(); }
}

export function approvalRequested(h: Awaited<ReturnType<typeof round4Target>>) {
    const requested = barrier<string>();
    registerApprovalToolCallReview(h.runtime.hooks, {
        async evaluate(input, signal) {
            const evaluation = await h.approval.evaluate(input, signal);
            assert.ok(evaluation.decision === "ask");
            requested.resolve(evaluation.request.approvalId);
            return evaluation;
        },
    });
    return requested.promise;
}
