import assert from "node:assert/strict";
import test from "node:test";

import { ContextCleanupService } from "../../../../src/context/Cleanup.js";
import { ContextRegistry } from "../../../../src/context/Registry.js";

test("retirement drains only the removed instance through its retained cleanup capability", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-retirement" });
    const context = await registry.create({
        principal: "user",
        environments: [
            { instance: "removed", workspace: "/old" },
            { instance: "other", workspace: "/other" },
        ],
    });
    await registry.recordEnvironmentCleanup(context.ctxId, {
        instance: "removed",
        kind: "alerts",
        workspace: "/old",
    });
    await registry.recordEnvironmentCleanup(context.ctxId, {
        instance: "other",
        kind: "alerts",
        workspace: "/previous-other",
    });
    await registry.detachInstance("removed");
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        gateway: () => {
            throw new Error("Live instance gateway is unavailable.");
        },
    });
    await assert.rejects(
        cleanup.reconcile(context.ctxId),
        /Context environment cleanup was incomplete/u,
    );
    const released: string[] = [];
    await cleanup.reconcileInstance("removed", {
        async releaseAlerts(workspace) {
            released.push(workspace);
        },
        async releaseInstanceReference() {},
    });
    assert.deepEqual(released, ["/old"]);
    assert.deepEqual(
        (await registry.listEnvironmentCleanup()).map(
            ({ cleanup: debt }) => debt,
        ),
        [{ instance: "other", kind: "alerts", workspace: "/previous-other" }],
    );
    assert.deepEqual(
        (await registry.lookup(context.ctxId, { principal: "user" }))
            .environments,
        [{ instance: "other", workspace: "/other" }],
    );
});

test("retirement preserves alert debt when the retained cleanup capability fails", async () => {
    const registry = new ContextRegistry({
        idFactory: () => "ctx-retirement-failure",
    });
    const context = await registry.create({ principal: "user" });
    const debt = {
        instance: "removed",
        kind: "alerts" as const,
        workspace: "/old",
    };
    await registry.recordEnvironmentCleanup(context.ctxId, debt);
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        gateway: () => undefined,
    });
    await assert.rejects(
        cleanup.reconcileInstance("removed", {
            async releaseAlerts() {
                throw new Error("release unavailable");
            },
            async releaseInstanceReference() {},
        }),
        /Context environment cleanup was incomplete/u,
    );
    assert.deepEqual(
        (await registry.listEnvironmentCleanup()).map(
            ({ cleanup: pending }) => pending,
        ),
        [debt],
    );
});
