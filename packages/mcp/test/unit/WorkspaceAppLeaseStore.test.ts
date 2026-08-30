import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
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
        assert.match(persisted, /"tokenHashes": \[\s*"[0-9a-f]{64}"/u);

        const restarted = new WorkspaceAppLeaseStore({ filePath });
        await restarted.initialize();
        assert.equal(await restarted.verify("alpha", "ctx-one", token), true);
        assert.equal(await restarted.verify("beta", "ctx-one", token), false);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("WorkspaceAppLeaseStore does not revoke sibling capabilities when Workspace is reopened after restart", async () => {
    const root = await createTestTempDirectory("workspace-app-lease-siblings");
    const filePath = join(root, "leases.json");
    try {
        const first = new WorkspaceAppLeaseStore({
            filePath,
            tokenFactory: () => "workspace-token-first-0001",
        });
        await first.initialize();
        const firstToken = await first.issue("alpha", "ctx-one");

        const restarted = new WorkspaceAppLeaseStore({
            filePath,
            tokenFactory: () => "workspace-token-second-0002",
        });
        await restarted.initialize();
        const secondToken = await restarted.issue("alpha", "ctx-one");

        assert.notEqual(secondToken, firstToken);
        assert.equal(await restarted.verify("alpha", "ctx-one", firstToken), true);
        assert.equal(await restarted.verify("alpha", "ctx-one", secondToken), true);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("WorkspaceAppLeaseStore loads version 1 single-token leases without invalidating them", async () => {
    const root = await createTestTempDirectory("workspace-app-lease-v1");
    const filePath = join(root, "leases.json");
    const token = "workspace-token-legacy-0001";
    try {
        await writeFile(filePath, JSON.stringify({
            leases: [{
                createdAt: "2026-08-30T00:00:00.000Z",
                ctxId: "ctx-one",
                instance: "alpha",
                tokenHash: createHash("sha256").update(token).digest("hex"),
                updatedAt: "2026-08-30T00:00:00.000Z",
            }],
            version: 1,
        }));
        const store = new WorkspaceAppLeaseStore({ filePath });
        await store.initialize();
        assert.equal(await store.verify("alpha", "ctx-one", token), true);
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
