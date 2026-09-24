import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    EXTENSION_API_VERSION,
    EXTENSION_MANIFEST_SCHEMA_VERSION,
    parseExtensionManifest,
} from "@portable-devshell/extension";

test("Access Extension manifest is eager, process-managed, and declares Config ownership and Core reads", async () => {
    const manifest = parseExtensionManifest(
        JSON.parse(
            await readFile(
                new URL("../../src/builtin/devshell-extension.json", import.meta.url),
                "utf8",
            ),
        ),
    );

    assert.equal(manifest.schemaVersion, EXTENSION_MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.apiVersion, EXTENSION_API_VERSION);
    assert.equal(manifest.id, "access");
    assert.equal(manifest.activation, "eager");
    assert.deepEqual(manifest.capabilities, ["processes"]);
    assert.deepEqual(manifest.config?.default, { endpoints: [] });
    assert.equal(manifest.config?.access?.["mcp.listenPort"], "read");
    assert.equal(manifest.config?.access?.["mcp.publicBaseUrl"], "read-write");
    assert.equal(manifest.config?.access?.["web.listenPort"], "read");
    assert.equal(manifest.config?.access?.["web.publicBaseUrl"], "read-write");
    assert.deepEqual(Object.keys(manifest.extensions).sort(), [
        "cli.native-commands",
        "web.applications",
    ]);
});
