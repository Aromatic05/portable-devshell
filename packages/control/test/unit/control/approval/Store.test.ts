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
        instanceName: asInstanceName("dev"),
        store,
        policy: { mode: "ask" },
        createId: () => "persisted-approval",
    });

    try {
        await service.evaluate({
            callId: "call-1",
            context: { source: "cli" },
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
