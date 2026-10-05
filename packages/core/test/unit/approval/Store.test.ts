import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { ApprovalService } from "../../../src/approval/execution/Service.ts";
import { InstanceApprovalStore } from "../../../src/approval/Store.ts";
import { createInstanceApprovalService } from "../../../src/approval/Factory.ts";

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
    const service = createInstanceApprovalService({
        appendEvent: async () => {},
        instanceName: asInstanceName("dev"),
        paths: { auditDatabaseFile: join(directory, "audit.sqlite3") },
        policy: { mode: "ask" },
    });
    t.after(async () => {
        service.close();
        await rm(directory, { force: true, recursive: true });
    });

    assert.deepEqual(await service.listApprovals(), []);
    const evaluation = await service.evaluate({
        callId: "database-call",
        source: "cli",
        inputSummary: "{}",
        toolName: "shell",
    });
    assert.equal(evaluation.decision, "ask");
    assert.deepEqual(
        (await service.listApprovals()).map((request) => request.callId),
        ["database-call"],
    );
    assert.equal(await readFile(legacyPath, "utf8"), legacyRecord);
});

test("instance approval store persists the latest approval record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approval-store-"));
    const databasePath = join(directory, "audit.sqlite3");
    const store = new InstanceApprovalStore(databasePath);
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

        const reopened = new InstanceApprovalStore(databasePath);
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
            reopened.close();
        }
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("instance approval store upserts by approval id and keeps latest state after reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approval-store-upsert-"));
    const databasePath = join(directory, "audit.sqlite3");
    const store = new InstanceApprovalStore(databasePath);
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
        store.close();

        const reopened = new InstanceApprovalStore(databasePath);
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
            reopened.close();
        }
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
