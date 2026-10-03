import assert from "node:assert/strict";
import test from "node:test";

import type { McpInstanceGateway } from "@portable-devshell/mcp";
import { ContextCleanupService } from "../../../../src/context/Cleanup.js";
import { ContextEnvironmentService } from "../../../../src/context/Environment.js";
import { ContextRegistry } from "../../../../src/context/Registry.js";
import { ContextService } from "../../../../src/context/Service.js";

test("terminal Context cleanup retains shared alerts until the final active association ends", async () => {
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
    const environment = new ContextEnvironmentService({
        contextRegistry: registry,
        cleanup,
        gateway: () => gateway,
        worker: () => undefined,
    });
    const service = new ContextService({
        registry,
        cleanup,
        environment,
        gateway: () => gateway,
        worker: () => undefined,
    });

    await service.disable(first.ctxId);
    assert.deepEqual(released, []);
    assert.deepEqual(
        (await registry.listEnvironmentCleanup(first.ctxId)).map(
            ({ cleanup: debt }) => debt,
        ),
        [{ instance: "local", kind: "alerts", workspace: "/shared" }],
    );
    assert.equal((await registry.listCleanupPending()).length, 1);

    await service.disable(second.ctxId);
    assert.deepEqual(released, ["/shared"]);
    await service.reconcile();
    assert.deepEqual(await registry.listEnvironmentCleanup(), []);
    assert.deepEqual(await registry.listCleanupPending(), []);
    assert.deepEqual(
        (await registry.list()).map((record) => record.status),
        ["disabled", "disabled"],
    );
});
