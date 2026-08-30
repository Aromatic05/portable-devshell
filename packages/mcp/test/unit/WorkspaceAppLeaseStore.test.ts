import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceAppLeaseStore } from "@portable-devshell/mcp/testing";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("WorkspaceAppLeaseStore persists only token hashes and verifies capabilities after restart", async () => {
    const root = await createTestTempDirectory("workspace-app-lease");
    const filePath = join(root, "leases.json");
    try {
        const store = new WorkspaceAppLeaseStore({ filePath });
        await store.initialize();
        const token = await store.issue("alpha", "ctx-one");
        assert.equal(await store.verify("alpha", "ctx-one", token), true);
        assert.equal(await store.verify("alpha", "ctx-one", `${token}-wrong`), false);

        const persisted = await readFile(filePath, "utf8");
        assert.equal(persisted.includes(token), false);
        assert.match(persisted, /"tokenHash": "[0-9a-f]{64}"/u);

        const restarted = new WorkspaceAppLeaseStore({ filePath });
        await restarted.initialize();
        assert.equal(await restarted.verify("alpha", "ctx-one", token), true);
        assert.equal(await restarted.verify("beta", "ctx-one", token), false);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("WorkspaceAppLeaseStore revokes Context and instance capabilities durably", async () => {
    const root = await createTestTempDirectory("workspace-app-lease-revoke");
    const filePath = join(root, "leases.json");
    try {
        const store = new WorkspaceAppLeaseStore({ filePath });
        await store.initialize();
        const alphaOne = await store.issue("alpha", "ctx-one");
        const alphaTwo = await store.issue("alpha", "ctx-two");
        const betaOne = await store.issue("beta", "ctx-one");

        await store.revokeContext("ctx-one");
        assert.equal(await store.verify("alpha", "ctx-one", alphaOne), false);
        assert.equal(await store.verify("beta", "ctx-one", betaOne), false);
        assert.equal(await store.verify("alpha", "ctx-two", alphaTwo), true);

        await store.revokeInstance("alpha");
        assert.equal(await store.verify("alpha", "ctx-two", alphaTwo), false);

        const restarted = new WorkspaceAppLeaseStore({ filePath });
        await restarted.initialize();
        assert.equal(await restarted.verify("alpha", "ctx-one", alphaOne), false);
        assert.equal(await restarted.verify("alpha", "ctx-two", alphaTwo), false);
        assert.equal(await restarted.verify("beta", "ctx-one", betaOne), false);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});
