import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { ApprovalService } from "../../../src/approval/execution/Service.ts";
import { InstanceApprovalStore } from "../../../src/approval/Store.ts";
import { createApprovalRuntime } from "../../../src/approval/index.ts";
import { createAuditRuntime } from "../../../src/audit/index.ts";

test("approval factory uses SQLite without importing or deleting legacy approvals", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "approval-factory-"));
    const legacyPath = join(directory, "approvals.jsonl");
    const legacyRecord = JSON.stringify({
        approvalId: "legacy-approval",
        callId: "legacy-call",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        inputSummary: "{}",
        instance: "dev",
        reason: "approval required",
        riskLevel: "medium",
        source: "cli",
        status: "pending",
        toolName: "shell",
    }) + "\n";
    await writeFile(legacyPath, legacyRecord);
    const audit = createAuditRuntime({
        eventBufferSize: 100,
        filePath: join(directory, "audit.sqlite3"),
        instanceName: asInstanceName("dev"),
    });
    const runtime = createApprovalRuntime({
        appendEvent: async () => {},
        instanceName: asInstanceName("dev"),
        policy: { mode: "ask" },
        stateStore: audit.api.state("approvals"),
    });
    t.after(async () => {
        runtime.close();
        await audit.close();
        await rm(directory, { force: true, recursive: true });
    });

    assert.deepEqual(await runtime.api.listApprovals(), []);
    const evaluation = await runtime.api.evaluate({
        callId: "database-call",
        source: "cli",
        inputSummary: "{}",
        toolName: "shell",
    });
    assert.equal(evaluation.decision, "ask");
    assert.deepEqual(
        (await runtime.api.listApprovals()).map((request) => request.callId),
        ["database-call"],
    );
    assert.equal(await readFile(legacyPath, "utf8"), legacyRecord);
});

test("instance approval store persists the latest approval record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approval-store-"));
    const databasePath = join(directory, "audit.sqlite3");
    const audit = createAuditRuntime({
        eventBufferSize: 100,
        filePath: databasePath,
        instanceName: asInstanceName("dev"),
    });
    const store = new InstanceApprovalStore(audit.api.state("approvals"));
    const service = new ApprovalService({
        events: { append: async () => {} },
        instanceName: asInstanceName("dev"),
        store,
        policy: { mode: "ask" },
        createId: () => "persisted-approval",
    });

    try {
        await service.evaluate({
            callId: "call-1",
            source: "cli",
            inputSummary: "{}",
            toolName: "shell",
        });
        service.close();
        await audit.close();

        const reopenedAudit = createAuditRuntime({
            eventBufferSize: 100,
            filePath: databasePath,
            instanceName: asInstanceName("dev"),
        });
        const reopened = new InstanceApprovalStore(
            reopenedAudit.api.state("approvals"),
        );
        try {
            assert.equal(
                (await reopened.get("persisted-approval"))?.status,
                "pending",
            );
            const recovered = new ApprovalService({
                events: { append: async () => {} },
                instanceName: asInstanceName("dev"),
                store: reopened,
                policy: { mode: "ask" },
            });
            assert.equal(
                (await recovered.getApproval("persisted-approval")).status,
                "cancelled",
            );
            recovered.close();
        } finally {
            await reopenedAudit.close();
        }
    } finally {
        await audit.close();
        await rm(directory, { force: true, recursive: true });
    }
});

test("instance approval store upserts by approval id and keeps latest state after reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approval-store-upsert-"));
    const databasePath = join(directory, "audit.sqlite3");
    const audit = createAuditRuntime({
        eventBufferSize: 100,
        filePath: databasePath,
        instanceName: asInstanceName("dev"),
    });
    const store = new InstanceApprovalStore(audit.api.state("approvals"));
    const pending = {
        approvalId: "approval-1",
        callId: "call-1",
        createdAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:05:00.000Z",
        inputSummary: "{}",
        instance: asInstanceName("dev"),
        reason: "approval required",
        riskLevel: "low" as const,
        source: "cli" as const,
        status: "pending" as const,
        toolName: "shell",
    };

    try {
        await store.append(pending);
        await store.append({
            ...pending,
            status: "approved",
            decision: {
                approvalId: pending.approvalId,
                decidedAt: "2020-01-01T00:01:00.000Z",
                decidedBy: "cli",
                decision: "approve",
            },
        });
        await store.delete("approval-1");
        assert.equal(await store.get("approval-1"), undefined);
        await store.append({
            ...pending,
            status: "approved",
            decision: {
                approvalId: pending.approvalId,
                decidedAt: "2020-01-01T00:01:00.000Z",
                decidedBy: "cli",
                decision: "approve",
            },
        });
        await audit.close();

        const reopenedAudit = createAuditRuntime({
            eventBufferSize: 100,
            filePath: databasePath,
            instanceName: asInstanceName("dev"),
        });
        const reopened = new InstanceApprovalStore(
            reopenedAudit.api.state("approvals"),
        );
        try {
            assert.equal(
                (await reopened.get("approval-1"))?.status,
                "approved",
            );
            assert.deepEqual(await reopened.list(), [
                {
                    ...pending,
                    status: "approved",
                    decision: {
                        approvalId: pending.approvalId,
                        decidedAt: "2020-01-01T00:01:00.000Z",
                        decidedBy: "cli",
                        decision: "approve",
                    },
                },
            ]);
        } finally {
            await reopenedAudit.close();
        }
    } finally {
        await audit.close();
        await rm(directory, { force: true, recursive: true });
    }
});
