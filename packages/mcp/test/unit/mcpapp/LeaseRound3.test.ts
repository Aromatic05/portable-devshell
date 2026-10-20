import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { McpAppLeaseStore } from "../../../src/mcpapp/app/Lease.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

test("round3 Lease evicts exactly the oldest sibling capability at the ninth restart and preserves tuple isolation", async () => {
    const filePath = join(await createTestTempDirectory("round3-lease-window"), "leases.json");
    const tokens: string[] = [];
    for (let generation = 0; generation < 9; generation++) {
        const store = new McpAppLeaseStore({ filePath });
        await store.initialize();
        tokens.push(await store.issue("demo", "ctx-window"));
    }
    const reloaded = new McpAppLeaseStore({ filePath });
    await reloaded.initialize();
    assert.equal(await reloaded.verify("demo", "ctx-window", tokens[0]!), false);
    for (const token of tokens.slice(1)) {
        assert.equal(await reloaded.verify("demo", "ctx-window", token), true);
        assert.equal(await reloaded.verify("other", "ctx-window", token), false);
        assert.equal(await reloaded.verify("demo", "ctx-other", token), false);
    }
    const persisted = await readFile(filePath, "utf8");
    for (const token of tokens) assert.equal(persisted.includes(token), false);
});

test("round3 Lease failed revocation rolls back capabilities then retry durably removes only the target Context", async () => {
    const filePath = join(await createTestTempDirectory("round3-lease-fault"), "leases.json");
    const store = new McpAppLeaseStore({ filePath });
    await store.initialize();
    const target = await store.issue("demo", "ctx-target");
    const sibling = await store.issue("demo", "ctx-sibling");
    await rm(filePath);
    await mkdir(filePath);
    await assert.rejects(store.revokeContext("ctx-target"), { code: "EISDIR" });
    assert.equal(await store.verify("demo", "ctx-target", target), true);
    assert.equal(await store.issue("demo", "ctx-target"), target);
    assert.equal(await store.verify("demo", "ctx-sibling", sibling), true);
    await rm(filePath, { recursive: true });
    await store.revokeContext("ctx-target");
    const reloaded = new McpAppLeaseStore({ filePath });
    await reloaded.initialize();
    assert.equal(await reloaded.verify("demo", "ctx-target", target), false);
    assert.equal(await reloaded.verify("demo", "ctx-sibling", sibling), true);
    assert.deepEqual(await reloaded.contextIds(), ["ctx-sibling"]);
});

test("round3 Lease queued issue/revoke/issue creates a fresh capability without resurrecting the revoked one", async () => {
    const store = new McpAppLeaseStore();
    const [first, , second] = await Promise.all([
        store.issue("demo", "ctx-race"), store.revokeContext("ctx-race"), store.issue("demo", "ctx-race"),
    ]);
    assert.notEqual(first, second);
    assert.equal(await store.verify("demo", "ctx-race", first), false);
    assert.equal(await store.verify("demo", "ctx-race", second), true);
    const duplicates = await Promise.all(Array.from({ length: 12 }, () => store.issue("demo", "ctx-race")));
    assert.deepEqual(duplicates, Array(12).fill(second));
});
