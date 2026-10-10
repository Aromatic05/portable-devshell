import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
    McpAppLeaseStore,
    McpAppPresenceStore,
} from "@portable-devshell/mcp/testing";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

{
    test("McpAppLeaseStore persists only token hashes and verifies capabilities after restart", async () => {
        const root = await createTestTempDirectory("workspace-app-lease");
        const filePath = join(root, "leases.json");
        try {
            const store = new McpAppLeaseStore({ filePath });
            await store.initialize();
            const token = await store.issue("alpha", "ctx-one");
            assert.equal(await store.verify("alpha", "ctx-one", token), true);
            assert.equal(
                await store.verify("alpha", "ctx-one", `${token}-wrong`),
                false,
            );

            const persisted = await readFile(filePath, "utf8");
            assert.equal(persisted.includes(token), false);
            assert.match(persisted, /"tokenHashes": \[\s*"[0-9a-f]{64}"/u);

            const restarted = new McpAppLeaseStore({ filePath });
            await restarted.initialize();
            assert.equal(
                await restarted.verify("alpha", "ctx-one", token),
                true,
            );
            assert.equal(
                await restarted.verify("beta", "ctx-one", token),
                false,
            );
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    test("McpAppLeaseStore does not revoke sibling capabilities when MCP App is reopened after restart", async () => {
        const root = await createTestTempDirectory(
            "workspace-app-lease-siblings",
        );
        const filePath = join(root, "leases.json");
        try {
            const first = new McpAppLeaseStore({
                filePath,
                tokenFactory: () => "workspace-token-first-0001",
            });
            await first.initialize();
            const firstToken = await first.issue("alpha", "ctx-one");

            const restarted = new McpAppLeaseStore({
                filePath,
                tokenFactory: () => "workspace-token-second-0002",
            });
            await restarted.initialize();
            const secondToken = await restarted.issue("alpha", "ctx-one");

            assert.notEqual(secondToken, firstToken);
            assert.equal(
                await restarted.verify("alpha", "ctx-one", firstToken),
                true,
            );
            assert.equal(
                await restarted.verify("alpha", "ctx-one", secondToken),
                true,
            );
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    test("McpAppLeaseStore rejects and cleans up version 1 single-token leases", async () => {
        const root = await createTestTempDirectory("workspace-app-lease-v1");
        const filePath = join(root, "leases.json");
        const token = "workspace-token-legacy-0001";
        try {
            await writeFile(
                filePath,
                JSON.stringify({
                    leases: [
                        {
                            createdAt: "2026-08-30T00:00:00.000Z",
                            ctxId: "ctx-one",
                            instance: "alpha",
                            tokenHash: createHash("sha256")
                                .update(token)
                                .digest("hex"),
                            updatedAt: "2026-08-30T00:00:00.000Z",
                        },
                    ],
                    version: 1,
                }),
            );

            // The expired v1 lease format is rejected, never migrated.
            const store = new McpAppLeaseStore({ filePath });
            await assert.rejects(
                store.initialize(),
                /Invalid MCP App lease store/u,
            );
            await assert.rejects(
                store.verify("alpha", "ctx-one", token),
                /not initialized/u,
            );

            // A restarted store still rejects the same legacy document.
            const retried = new McpAppLeaseStore({ filePath });
            await assert.rejects(
                retried.initialize(),
                /Invalid MCP App lease store/u,
            );

            // Cleanup: removing the expired file starts a clean store that
            // never resurrects the legacy capability.
            await rm(filePath, { force: true });
            const cleaned = new McpAppLeaseStore({ filePath });
            await cleaned.initialize();
            assert.equal(await cleaned.verify("alpha", "ctx-one", token), false);
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    test("McpAppLeaseStore revokes Context and instance capabilities durably", async () => {
        const root = await createTestTempDirectory(
            "workspace-app-lease-revoke",
        );
        const filePath = join(root, "leases.json");
        try {
            const store = new McpAppLeaseStore({ filePath });
            await store.initialize();
            const alphaOne = await store.issue("alpha", "ctx-one");
            const alphaTwo = await store.issue("alpha", "ctx-two");
            const betaOne = await store.issue("beta", "ctx-one");

            await store.revokeContext("ctx-one");
            assert.equal(
                await store.verify("alpha", "ctx-one", alphaOne),
                false,
            );
            assert.equal(await store.verify("beta", "ctx-one", betaOne), false);
            assert.equal(
                await store.verify("alpha", "ctx-two", alphaTwo),
                true,
            );

            await store.revokeInstance("alpha");
            assert.equal(
                await store.verify("alpha", "ctx-two", alphaTwo),
                false,
            );

            const restarted = new McpAppLeaseStore({ filePath });
            await restarted.initialize();
            assert.equal(
                await restarted.verify("alpha", "ctx-one", alphaOne),
                false,
            );
            assert.equal(
                await restarted.verify("alpha", "ctx-two", alphaTwo),
                false,
            );
            assert.equal(
                await restarted.verify("beta", "ctx-one", betaOne),
                false,
            );
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
}

{
    test("Workspace App presence distinguishes bootstrap, live watch, handoff, and teardown", async () => {
        let now = 1_000;
        const presence = new McpAppPresenceStore({ now: () => now });

        presence.open("demo", "ctx-a");
        assert.equal(presence.has("demo", "ctx-a"), true);
        assert.equal(presence.isActive("demo", "ctx-a", 60_000), false);

        presence.touch("demo", "ctx-a");
        assert.equal(presence.isActive("demo", "ctx-a", 60_000), true);
        now += 5_001;
        assert.equal(presence.isActive("demo", "ctx-a", 60_000), false);

        presence.beginWatch("demo", "ctx-a");
        now += 30_000;
        assert.equal(presence.isActive("demo", "ctx-a", 60_000), true);

        presence.endWatch("demo", "ctx-a");
        assert.equal(presence.isActive("demo", "ctx-a", 60_000), true);
        now += 4_999;
        assert.equal(presence.isActive("demo", "ctx-a", 60_000), true);
        now += 2;
        assert.equal(presence.isActive("demo", "ctx-a", 60_000), false);

        const ready = presence.waitUntilActive("demo", "ctx-a", 60_000, 100);
        presence.beginWatch("demo", "ctx-a");
        assert.equal(await ready, true);

        presence.revokeContext("ctx-a");
        assert.equal(presence.has("demo", "ctx-a"), false);

        presence.open("demo", "ctx-b");
        presence.revokeInstance("demo");
        assert.equal(presence.has("demo", "ctx-b"), false);
    });
}
