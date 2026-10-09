import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { withTestspaceControlConnection } from "./TestspaceReverse.mjs";

/** Exercise MCP ToolCall -> pending Approval -> MCPApp human action -> Audit. */
export async function runTestspaceApprovalSmoke({ endpoint, instance, runtimeDirectory, workspace }) {
    const client = new Client({ name: "testspace-approval-smoke", version: "0.0.0" });
    let ctxId;
    let originalPolicy;
    let changed = false;
    try {
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
        const environment = await client.callTool({ name: "environ_info", arguments: { workspace } });
        assert.equal(environment.isError, false);
        ctxId = environment.structuredContent?.ctxId;
        assert.ok(typeof ctxId === "string" && ctxId.length > 0);
        await withTestspaceControlConnection(runtimeDirectory, async (shared, connection) => {
            const config = shared.createConfigTransport(connection);
            const before = await config.snapshot();
            originalPolicy = before.view.instances.find((entry) => entry.name === instance)?.approvalPolicy;
            assert.ok(originalPolicy);
            // The activity Connector never calls file_grep; keep its tools
            // allowed and limit approval injection to this one exact tool.
            changed = true;
            await config.update({ instance: { instanceName: instance, patch: {
                approvalPolicy: { mode: "allow", rules: [
                    { decision: "ask", match: "exact", source: "mcp", toolName: "file_grep" },
                ] },
            } } });
            assert.equal((await config.snapshot()).view.instances.find((entry) =>
                entry.name === instance).approvalPolicy.rules[0].toolName, "file_grep");
        });

        const outcomes = [];
        for (const decision of ["approve", "deny"]) {
            const operation = client.callTool({ name: "file_grep", arguments: {
                ctxId, paths: ["./README.md"], pattern: "testspace",
            } }).then((value) => ({ kind: "result", value }),
                (error) => ({ kind: "error", error }));
            const approval = await awaitApproval(runtimeDirectory, instance, ctxId);
            assert.equal(approval.status, "pending");
            const result = await client.callTool({ name: "mcpapp_action", arguments: {
                ctxId, itemId: approval.approvalId, actionId: decision,
                requestId: randomUUID(),
            } });
            assert.equal(result.isError, false, JSON.stringify(result.structuredContent ?? result.content));
            assert.equal(result.structuredContent?.status, "applied");
            const terminal = await settleWithin(operation);
            if (decision === "approve") {
                assert.equal(terminal.kind, "result");
                assert.notEqual(terminal.value.isError, true);
            } else {
                assert.ok(terminal.kind === "error" || terminal.value.isError === true,
                    "Denied MCP ToolCall must not return success.");
            }
            const final = await withTestspaceControlConnection(runtimeDirectory, async (shared, connection) =>
                await shared.createApprovalTransport(connection, instance).get(approval.approvalId));
            assert.equal(final.status, decision === "approve" ? "approved" : "denied");
            outcomes.push({ decision, status: final.status, toolName: final.toolName });
        }

        const audit = await withTestspaceControlConnection(runtimeDirectory, async (shared, connection) =>
            await shared.createToolTransport(connection, instance).listCalls({ ctxId, limit: 100 }));
        assert.ok(audit.some((entry) => entry.toolName === "file_grep" && entry.status === "completed"));
        assert.ok(audit.some((entry) => entry.toolName === "file_grep" && entry.status === "denied"),
            JSON.stringify(audit.map((entry) => ({ name: entry.toolName, status: entry.status, ctxId: entry.ctxId }))));
        assert.equal(audit.filter((entry) => entry.toolName === "mcpapp_action" && entry.status === "completed").length, 2);
        return { instance, ctxId, decisions: outcomes, auditRecords: audit.length };
    } finally {
        try {
            if (changed) {
                // Resolve stray pending test approvals before restoring the policy.
                await withTestspaceControlConnection(runtimeDirectory, async (shared, connection) => {
                    const approvals = shared.createApprovalTransport(connection, instance);
                    const pending = (await approvals.snapshot({ pendingOnly: true })).approvals
                        .filter((entry) => entry.ctxId === ctxId && entry.toolName === "file_grep");
                    for (const approval of pending)
                        await approvals.decide(approval.approvalId, "deny");
                    const config = shared.createConfigTransport(connection);
                    await config.update({ instance: { instanceName: instance,
                        patch: { approvalPolicy: originalPolicy } } });
                    assert.deepEqual((await config.snapshot()).view.instances.find((entry) =>
                        entry.name === instance).approvalPolicy, originalPolicy);
                });
            }
        } finally {
            await client.close().catch(() => undefined);
        }
    }
}

async function settleWithin(operation) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("Approval tool did not settle.")), 15_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function awaitApproval(runtimeDirectory, instance, ctxId) {
    return await withTestspaceControlConnection(runtimeDirectory, async (shared, connection) => {
        const api = shared.createApprovalTransport(connection, instance);
        for (let i = 0; i < 75; i++) {
            const pending = (await api.snapshot({ pendingOnly: true })).approvals.find((item) =>
                item.ctxId === ctxId && item.toolName === "file_grep");
            if (pending) return pending;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Real MCP file_grep never entered pending Approval state.");
    });
}
