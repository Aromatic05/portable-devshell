import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
    EXTENSION_API_VERSION,
    EXTENSION_MANIFEST_SCHEMA_VERSION,
} from "@portable-devshell/extension";

import { preflightControlUpdate } from "../../../../../src/migration/Control.ts";
import { ExtensionPathLayout } from "../../../../../src/control/extension/state/Layout.ts";
import { ExtensionRegistryStore } from "../../../../../src/control/extension/state/Store.ts";
import { createTestTempDirectory } from "../../../../../../../test/TestTempDirectory.ts";

test("Extension registry persists selected and last-known-good generations atomically", async (t) => {
    const root = await createTestTempDirectory("extension-registry");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const paths = new ExtensionPathLayout({
        dataHome: join(root, "data"),
        homeDirectory: join(root, "home"),
        runtimeRoot: join(root, "runtime"),
    });
    const store = new ExtensionRegistryStore(paths.registryFile);

    assert.deepEqual(await store.read(), { extensions: {}, schemaVersion: 1 });
    await store.write({
        extensions: {
            agent: {
                enabled: true,
                lastKnownGoodGeneration: "0.1.0-good",
                selectedGeneration: "0.2.0-next",
            },
        },
        schemaVersion: 1,
    });

    assert.deepEqual(await store.read(), {
        extensions: {
            agent: {
                enabled: true,
                lastKnownGoodGeneration: "0.1.0-good",
                selectedGeneration: "0.2.0-next",
            },
        },
        schemaVersion: 1,
    });
    const source = await readFile(paths.registryFile, "utf8");
    assert.match(source, /"lastKnownGoodGeneration": "0\.1\.0-good"/u);
});

test("update preflight validates referenced installed Extension generations before mutation", async (t) => {
    const root = await createTestTempDirectory("extension-update-preflight");
    const homeDirectory = join(root, "home");
    const dataHome = join(root, "data");
    const paths = new ExtensionPathLayout({
        dataHome,
        homeDirectory,
        runtimeRoot: join(root, "runtime"),
    });
    const store = new ExtensionRegistryStore(paths.registryFile);
    const id = "example";
    const generation = "1.0.0-test";
    await mkdir(paths.generationDirectory(id, generation), { recursive: true });
    const manifest = (range: string) => ({
        activation: "lazy",
        apiVersion: EXTENSION_API_VERSION,
        capabilities: [],
        entry: "extension.mjs",
        extensions: {},
        hostDependencies: { "@modelcontextprotocol/client": range },
        id,
        name: "Example",
        schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
        version: "1.0.0",
    });
    await writeFile(
        paths.manifestFile(id, generation),
        `${JSON.stringify(manifest("^2.0.0"))}\n`,
        "utf8",
    );
    await store.write({
        extensions: {
            [id]: {
                enabled: true,
                lastKnownGoodGeneration: generation,
                selectedGeneration: generation,
            },
        },
        schemaVersion: 1,
    });
    t.after(async () => await rm(root, { force: true, recursive: true }));

    assert.deepEqual(
        await preflightControlUpdate({
            environment: { ...process.env, XDG_DATA_HOME: dataHome },
            homeDirectory,
        }),
        {
            extensions: { checkedGenerations: 1 },
            migration: { domains: [], required: false },
        },
    );

    await writeFile(
        paths.manifestFile(id, generation),
        `${JSON.stringify(manifest("^3.0.0"))}\n`,
        "utf8",
    );
    await assert.rejects(async () =>
        preflightControlUpdate({
            environment: { ...process.env, XDG_DATA_HOME: dataHome },
            homeDirectory,
        }),
    );
});

test("Extension path layout separates immutable code, persistent data, mutable state and runtime directories", async (t) => {
    const root = await createTestTempDirectory("extension-path-layout");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const paths = new ExtensionPathLayout({
        dataHome: join(root, "xdg-data"),
        homeDirectory: join(root, "home"),
        runtimeRoot: join(root, "runtime"),
    });

    assert.equal(
        paths.generationDirectory("agent", "0.1.0-hash"),
        join(
            root,
            "xdg-data",
            "portable-devshell",
            "extensions",
            "agent",
            "0.1.0-hash",
        ),
    );
    assert.equal(
        paths.dataDirectory("agent"),
        join(root, "xdg-data", "portable-devshell", "extension-data", "agent"),
    );
    assert.equal(
        paths.stateDirectory("agent"),
        join(
            root,
            "home",
            ".devshell",
            "control",
            "extensions",
            "state",
            "agent",
        ),
    );
    assert.equal(
        paths.runtimeDirectory("agent", "0.1.0-hash"),
        join(root, "runtime", "agent", "0.1.0-hash"),
    );
    assert.throws(
        () => paths.generationDirectory("../escape", "g1"),
        /Invalid Extension id/u,
    );
    assert.throws(
        () => paths.runtimeDirectory("agent", "../escape"),
        /Invalid Extension generation/u,
    );
});
