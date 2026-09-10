import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { TuiAppStore } from "../../src/state/TuiAppStore.ts";
import { projectAuditContexts } from "../../src/view/page/audit/TuiAuditContextProjection.ts";

test("Audit excludes caller-recorded delegated Worker activity", () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({
        instanceState: {
            alpha: {
                approvals: [
                    {
                        approvalId: "approval-agent",
                        callId: "call-agent",
                        createdAt: "2026-09-10T12:00:00.000Z",
                        ctxId: "ext-agent-session",
                        expiresAt: "2026-09-10T12:05:00.000Z",
                        extensionId: "agent",
                        inputSummary: "{}",
                        instance: asInstanceName("alpha"),
                        reason: "Approval required.",
                        recording: "caller",
                        riskLevel: "medium",
                        source: "extension",
                        status: "pending",
                        toolName: "file_read",
                        workspace: "/workspace",
                    },
                    {
                        approvalId: "approval-host",
                        callId: "call-host",
                        createdAt: "2026-09-10T12:01:00.000Z",
                        ctxId: "ctx-host",
                        expiresAt: "2026-09-10T12:06:00.000Z",
                        inputSummary: "{}",
                        instance: asInstanceName("alpha"),
                        reason: "Approval required.",
                        recording: "host",
                        riskLevel: "medium",
                        source: "mcp",
                        status: "pending",
                        toolName: "bash_run",
                        workspace: "/workspace",
                    },
                ],
            },
        },
    });

    assert.equal(store.getState().readModel.instanceState.alpha?.approvals.length, 2);
    assert.deepEqual(
        projectAuditContexts(store.getState(), "alpha").map((context) =>
            context.key.kind === "context" ? context.key.ctxId : "unscoped",
        ),
        ["ctx-host"],
    );
});
