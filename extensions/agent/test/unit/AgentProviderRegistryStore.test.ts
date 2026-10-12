import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
    AgentProviderRegistryStore,
    emptyAgentProviderRegistry,
    type AgentProviderRegistrySnapshot,
} from "../../src/builtin/provider/AgentProviderRegistryStore.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { databaseFixture } from "../helpers/Database.ts";

const installed: AgentProviderRegistrySnapshot = {
    defaultProvider: "pi",
    providers: { pi: { enabled: true, installedVersion: "0.1.3" } },
    schemaVersion: 2,
};

for (const schemaVersion of [1, 2]) {
    test(`Registry migrates legacy schema v${schemaVersion} once and preserves the JSON`, async (t) => {
        const h = await harness(t);
        const legacy = JSON.stringify(
            schemaVersion === 1
                ? {
                      ...installed,
                      providers: {
                          pi: {
                              enabled: true,
                              selectedGeneration: "old",
                              lastKnownGoodGeneration: "old",
                          },
                      },
                      schemaVersion,
                  }
                : installed,
        );
        await writeFile(h.legacyPath, legacy);
        assert.deepEqual(
            await h.store.read(),
            schemaVersion === 1
                ? {
                      defaultProvider: "pi",
                      providers: { pi: { enabled: true } },
                      schemaVersion: 2,
                  }
                : installed,
        );
        await h.store.write(emptyAgentProviderRegistry());
        assert.equal(await readFile(h.legacyPath, "utf8"), legacy);
        await h.store.close();
        const reopened = h.reopen();
        assert.deepEqual(await reopened.read(), emptyAgentProviderRegistry());
        assert.equal(await readFile(h.legacyPath, "utf8"), legacy);
    });
}

test("Registry persists schemaV2 snapshots across capability reopen", async (t) => {
    const h = await harness(t);
    await h.store.write(installed);
    await h.store.close();
    assert.deepEqual(await h.reopen().read(), installed);
    await assert.rejects(readFile(h.legacyPath), { code: "ENOENT" });
});

test("Initial empty state is durable and never imports a later legacy file", async (t) => {
    const h = await harness(t);
    assert.deepEqual(await h.store.read(), emptyAgentProviderRegistry());
    await h.store.close();
    await writeFile(h.legacyPath, JSON.stringify(installed));
    assert.deepEqual(await h.reopen().read(), emptyAgentProviderRegistry());
});

test("Failed SQLite writes roll back and do not block subsequent serialized writes", async (t) => {
    const h = await harness(t);
    await h.store.write(installed);
    h.database.failNextCommit();
    await assert.rejects(
        h.store.write(emptyAgentProviderRegistry()),
        /injected commit failure/u,
    );
    assert.deepEqual(await h.store.read(), installed);
    const disabled = { ...installed, providers: { pi: { enabled: false } } };
    await Promise.all([
        h.store.write(emptyAgentProviderRegistry()),
        h.store.write(disabled),
    ]);
    assert.deepEqual(await h.store.read(), disabled);
    assert.equal(h.database.opens, 1);
    await h.store.close();
    await h.store.close();
    assert.equal(h.database.closes, 1);
    await assert.rejects(h.store.read(), /store is closed/u);
});

test("Invalid legacy data rolls back initialization and releases the handle for retry", async (t) => {
    const h = await harness(t);
    await writeFile(
        h.legacyPath,
        '{"schemaVersion":2,"providers":{"pi":{"enabled":"yes"}}}',
    );
    await assert.rejects(h.store.read(), /registry entry is invalid/u);
    assert.equal(h.database.closes, 1);
    await writeFile(h.legacyPath, JSON.stringify(installed));
    assert.deepEqual(await h.store.read(), installed);
    assert.equal(h.database.opens, 2);
});

test("Failed first import leaves legacy JSON intact and can be retried", async (t) => {
    const h = await harness(t);
    const legacy = JSON.stringify(installed);
    await writeFile(h.legacyPath, legacy);
    h.database.failNextCommit();
    await assert.rejects(h.store.read(), /injected commit failure/u);
    assert.equal(h.database.closes, 1);
    assert.equal(await readFile(h.legacyPath, "utf8"), legacy);
    assert.deepEqual(await h.store.read(), installed);
});

async function harness(t: test.TestContext) {
    const root = await createTestTempDirectory("agent-provider-registry");
    const legacyPath = join(root, "providers.json");
    const database = databaseFixture(join(root, "providers.sqlite3"));
    const stores: AgentProviderRegistryStore[] = [];
    const reopen = () => {
        const store = new AgentProviderRegistryStore(
            database.capability,
            legacyPath,
        );
        stores.push(store);
        return store;
    };
    t.after(async () => {
        for (const store of stores) await store.close();
        await rm(root, { recursive: true, force: true });
    });
    return { database, legacyPath, reopen, store: reopen() };
}
