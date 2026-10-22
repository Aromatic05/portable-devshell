import assert from "node:assert/strict";
import { stat, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import test from "node:test";
import { McpAppActionStore } from "../../src/mcpapp/ActionStore.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("MCP App Receipt store measures full-file persistence cost as records grow", async () => {
    const home = await createTestTempDirectory("mcpapp-action-store-benchmark");
    const filePath = join(home, "receipts.json");
    try {
        const store = new McpAppActionStore({ filePath });
        await store.initialize();
        let previous = 0;
        let previousBytes = 0;
        for (const count of [50, 200, 500]) {
            const started = performance.now();
            for (let i = previous; i < count; i++) {
                await store.prepareOnce("ctx-benchmark", "demo", {
                    actionId: `receipt-${i}`, instance: "demo", itemId: `item-${i}`,
                    operation: "goal-pause", targetId: `item-${i}`,
                });
            }
            const totalMs = performance.now() - started;
            const bytes = (await stat(filePath)).size;
            assert.ok(bytes > previousBytes);
            console.log(`Receipt metrics: count=${count} fileBytes=${bytes} avgPersistMs=${(totalMs / (count - previous)).toFixed(3)}`);
            previousBytes = bytes;
            previous = count;
        }
        const before = await stat(filePath);
        await store.revokeContext("ctx-no-match");
        assert.equal((await stat(filePath)).mtimeMs, before.mtimeMs, "no-op revoke must not rewrite the entire store");
        const restored = new McpAppActionStore({ filePath });
        await restored.initialize();
        assert.ok(await restored.get("receipt-499"));
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
