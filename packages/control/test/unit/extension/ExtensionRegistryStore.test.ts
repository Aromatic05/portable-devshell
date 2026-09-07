import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ExtensionPathLayout } from "../../../src/control/extension/ExtensionPathLayout.ts";
import { ExtensionRegistryStore } from "../../../src/control/extension/ExtensionRegistryStore.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

test("Extension registry persists selected and last-known-good generations atomically", async (t) => {
    const root = await createTestTempDirectory("extension-registry");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const paths = new ExtensionPathLayout({
        dataHome: join(root, "data"),
        homeDirectory: join(root, "home"),
        runtimeRoot: join(root, "runtime")
    });
    const store = new ExtensionRegistryStore(paths.registryFile);

    assert.deepEqual(await store.read(), { extensions: {}, schemaVersion: 1 });
    await store.write({
        extensions: {
            agent: {
                enabled: true,
                lastKnownGoodGeneration: "0.1.0-good",
                selectedGeneration: "0.2.0-next"
            }
        },
        schemaVersion: 1
    });

    assert.deepEqual(await store.read(), {
        extensions: {
            agent: {
                enabled: true,
                lastKnownGoodGeneration: "0.1.0-good",
                selectedGeneration: "0.2.0-next"
            }
        },
        schemaVersion: 1
    });
    const source = await readFile(paths.registryFile, "utf8");
    assert.match(source, /"lastKnownGoodGeneration": "0\.1\.0-good"/u);
});

test("Extension path layout separates immutable code, persistent data, mutable state and runtime directories", async (t) => {
    const root = await createTestTempDirectory("extension-path-layout");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const paths = new ExtensionPathLayout({
        dataHome: join(root, "xdg-data"),
        homeDirectory: join(root, "home"),
        runtimeRoot: join(root, "runtime")
    });

    assert.equal(paths.generationDirectory("agent", "0.1.0-hash"), join(root, "xdg-data", "portable-devshell", "extensions", "agent", "0.1.0-hash"));
    assert.equal(paths.dataDirectory("agent"), join(root, "xdg-data", "portable-devshell", "extension-data", "agent"));
    assert.equal(paths.stateDirectory("agent"), join(root, "home", ".devshell", "control", "extensions", "state", "agent"));
    assert.equal(paths.runtimeDirectory("agent", "0.1.0-hash"), join(root, "runtime", "agent", "0.1.0-hash"));
    assert.throws(() => paths.generationDirectory("../escape", "g1"), /Invalid Extension id/u);
    assert.throws(() => paths.runtimeDirectory("agent", "../escape"), /Invalid Extension generation/u);
});
