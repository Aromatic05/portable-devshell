import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { ApprovalService } from "../../../../src/control/approval/Service.js";
import { InstanceApprovalStore } from "../../../../src/control/approval/Store.js";

test("instance approval store persists the latest approval record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approval-store-"));
    const databasePath = join(directory, "audit.sqlite3");
    const legacyPath = join(directory, "approvals.jsonl");
    const store = new InstanceApprovalStore(databasePath, legacyPath);
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

        const reopened = new InstanceApprovalStore(databasePath, legacyPath);
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
    const legacyPath = join(directory, "approvals.jsonl");
    const store = new InstanceApprovalStore(databasePath, legacyPath);
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
        store.close();

        const reopened = new InstanceApprovalStore(databasePath, legacyPath);
        try {
            assert.equal((await reopened.get("approval-1"))?.status, "approved");
            assert.deepEqual(await reopened.list(), [{
                ...pending,
                status: "approved",
                decision: {
                    approvalId: pending.approvalId,
                    decidedAt: "2020-01-01T00:01:00.000Z",
                    decidedBy: "cli",
                    decision: "approve",
                },
            }]);
        } finally {
            reopened.close();
        }
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
