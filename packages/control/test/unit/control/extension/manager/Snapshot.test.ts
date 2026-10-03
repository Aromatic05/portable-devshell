import assert from "node:assert/strict";
import test from "node:test";

import {
    EXTENSION_API_VERSION,
    EXTENSION_MANIFEST_SCHEMA_VERSION,
    type ExtensionManifest,
} from "@portable-devshell/extension";

import { ExtensionHost } from "../../../../../src/extension/host/Host.ts";
import { ExtensionChangeHub } from "../../../../../src/extension/manager/Change.ts";
import { readExtensionSnapshot } from "../../../../../src/extension/manager/Snapshot.ts";
import { ExtensionPointRegistry } from "../../../../../src/extension/registration/PointRegistry.ts";
import { cloneExtensionRegistry, type ExtensionRegistrySnapshot } from "../../../../../src/extension/state/Model.ts";
import { tuiPagesExtensionPointDefinition } from "../../../../../src/extension/api/point/tui/Declaration.ts";
import { TuiExtensionPageService } from "../../../../../src/extension/api/point/tui/Endpoint.ts";

test("manager snapshot keeps public records and page catalogs within the host atomic read", async (context) => {
    let registry: ExtensionRegistrySnapshot = {
        extensions: { alpha: { enabled: true, selectedGeneration: "generation-a" } },
        schemaVersion: 1,
    };
    const manifest: ExtensionManifest = {
        activation: "lazy",
        apiVersion: EXTENSION_API_VERSION,
        capabilities: [],
        entry: "extension.mjs",
        extensions: { "tui.pages": [{ id: "alpha-page", title: "Alpha" }] },
        hostDependencies: {},
        id: "alpha",
        name: "Alpha",
        schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
        version: "1.0.0",
    };
    const changes = new ExtensionChangeHub();
    const host = new ExtensionHost({
        changeHub: changes,
        loader: {
            points: new ExtensionPointRegistry([tuiPagesExtensionPointDefinition]),
            load: async () => { throw new Error("A catalog snapshot must not activate the extension."); },
            readManifest: async () => manifest,
        },
        registry: {
            read: async () => cloneExtensionRegistry(registry),
            write: async (next) => { registry = cloneExtensionRegistry(next); },
        },
    });
    await host.start();
    context.after(() => host.stop());
    const pages = new TuiExtensionPageService(host);
    const catalogs = () => ({
        tuiPages: [...pages.list()],
        tuiSupported: true,
        webApplications: [],
        webPages: [],
        webSupported: false,
    });
    let disabling: Promise<void> | undefined;
    const before = await readExtensionSnapshot(host, () => {
        disabling = host.disable("alpha");
        return catalogs();
    });
    assert.ok(disabling);
    await disabling;
    const after = await readExtensionSnapshot(host, catalogs);
    assert.equal(before.extensions[0]?.enabled, true);
    assert.deepEqual(before.tuiPages, [{ extensionId: "alpha", id: "alpha-page", title: "Alpha" }]);
    assert.equal("retired" in before.extensions[0]!, false);
    assert.equal(after.extensions[0]?.enabled, false);
    assert.deepEqual(after.tuiPages, []);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.revision, changes.revision);
});
