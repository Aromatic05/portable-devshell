import assert from "node:assert/strict";
import test from "node:test";

import type { McpInstanceGateway } from "@portable-devshell/mcp";
import { ContextCleanupService } from "../../../../src/context/Service/Cleanup.js";
import { ContextRegistry } from "../../../../src/context/Registry/index.js";

test("ContextCleanupService terminates owned work and settles cleanup without ContextService", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-owned" });
    const created = await registry.create({
        principal: "user",
        environments: [{ instance: "local", workspace: "/owned" }],
    });
    const terminal = await registry.disable(created.ctxId);
    const events: string[] = [];
    const gateway = {
        goalContinuation() {},
        async readGoal() {
            return { goalId: "goal-owned", status: "active" as const };
        },
        async manageGoal(_instance: string, input: { action: string }) {
            events.push(`goal:${input.action}`);
        },
        async listWaits() {
            return [
                {
                    waitId: "wait-owned",
                    createdByCtxId: created.ctxId,
                    status: "waiting",
                },
                {
                    waitId: "wait-foreign",
                    createdByCtxId: "ctx-foreign",
                    status: "waiting",
                },
                {
                    waitId: "wait-resolved",
                    createdByCtxId: created.ctxId,
                    status: "resolved",
                },
            ];
        },
        async cancelWait(_instance: string, waitId: string) {
            events.push(`cancel:${waitId}`);
        },
        async consumeWait(_instance: string, waitId: string) {
            events.push(`consume:${waitId}`);
        },
        async contextTerminated(
            _instance: string,
            ctxId: string,
            reason: string,
        ) {
            events.push(`terminated:${ctxId}:${reason}`);
        },
        approval: {
            async listApprovals() {
                return [
                    { approvalId: "approval-owned", ctxId: created.ctxId, status: "pending" },
                    { approvalId: "approval-foreign", ctxId: "ctx-foreign", status: "pending" },
                ];
            },
            async cancelApproval(_instance: string, approvalId: string, reason: string) {
                events.push(`approval:${approvalId}:${reason}`);
            },
        },
        async releaseAlerts(_instance: string, workspace: string) {
            events.push(`alerts:${workspace}`);
        },
        async releaseInstanceReference(_instance: string, ctxId: string) {
            events.push(`reference:${ctxId}`);
        },
    } as unknown as McpInstanceGateway;
    const revoked: string[] = [];
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        gateway: () => gateway,
    });
    cleanup.bindPresentation({
        async revokeContext(ctxId) {
            revoked.push(ctxId);
        },
        async revokeInstance() {},
    });

    await cleanup.terminate(terminal);

    assert.deepEqual(revoked, [created.ctxId]);
    assert.deepEqual(events, [
        "goal:stop",
        "cancel:wait-owned",
        "consume:wait-resolved",
        `terminated:${created.ctxId}:disabled`,
        `approval:approval-owned:Context ${created.ctxId} was disabled.`,
        "alerts:/owned",
        `reference:${created.ctxId}`,
    ]);
    assert.deepEqual(await registry.listEnvironmentCleanup(created.ctxId), []);
    assert.deepEqual(await registry.listCleanupPending(), []);
});

test("ContextCleanupService keeps failed cleanup pending and reconcile retries it", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-retry" });
    const created = await registry.create({
        principal: "user",
        environments: [{ instance: "local", workspace: "/retry" }],
    });
    const terminal = await registry.disable(created.ctxId);
    let releaseAttempts = 0;
    const gateway = {
        async releaseAlerts() {
            releaseAttempts += 1;
            if (releaseAttempts === 1)
                throw new Error("temporary release failure");
        },
        async releaseInstanceReference() {},
    } as unknown as McpInstanceGateway;
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        gateway: () => gateway,
    });

    await cleanup.terminate(terminal);

    assert.equal((await registry.listCleanupPending()).length, 1);
    assert.deepEqual(
        (await registry.listEnvironmentCleanup(created.ctxId)).map(
            ({ cleanup: debt }) => debt,
        ),
        [{ instance: "local", kind: "alerts", workspace: "/retry" }],
    );

    await cleanup.reconcile();

    assert.equal(releaseAttempts, 2);
    assert.deepEqual(await registry.listEnvironmentCleanup(created.ctxId), []);
    assert.deepEqual(await registry.listCleanupPending(), []);
});

test("shared alerts remain owned until the final active Context terminates", async () => {
    let sequence = 0;
    const registry = new ContextRegistry({
        idFactory: () => `ctx-shared-${++sequence}`,
    });
    const first = await registry.create({
        principal: "user",
        environments: [{ instance: "local", workspace: "/shared" }],
    });
    const second = await registry.create({
        principal: "user",
        environments: [{ instance: "local", workspace: "/shared" }],
    });
    const released: string[] = [];
    const gateway = {
        async releaseAlerts(_instance: string, workspace: string) {
            released.push(workspace);
        },
        async releaseInstanceReference() {},
    } as unknown as McpInstanceGateway;
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        gateway: () => gateway,
    });

    await cleanup.terminate(await registry.disable(first.ctxId));

    assert.deepEqual(released, []);
    assert.deepEqual(
        (await registry.listEnvironmentCleanup(first.ctxId)).map(
            ({ cleanup: debt }) => debt,
        ),
        [{ instance: "local", kind: "alerts", workspace: "/shared" }],
    );
    assert.equal((await registry.listCleanupPending()).length, 1);

    await cleanup.terminate(await registry.disable(second.ctxId));
    assert.deepEqual(released, ["/shared"]);
    await cleanup.reconcile();

    assert.deepEqual(released, ["/shared", "/shared"]);
    assert.deepEqual(await registry.listEnvironmentCleanup(), []);
    assert.deepEqual(await registry.listCleanupPending(), []);
});
