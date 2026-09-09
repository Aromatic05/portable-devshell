import assert from "node:assert/strict";
import test from "node:test";

import {
    EXTENSION_API_VERSION,
    type ExtensionManifest
} from "@portable-devshell/extension";

import { createControlExtensionPointRegistry } from "../../../src/composition/ControlExtensionPointRegistry.ts";
import { ExtensionCatalog } from "../../../src/control/extension/host/generation/ExtensionCatalog.ts";

function manifest(
    id: string,
    generation: string,
    extensions: ExtensionManifest["extensions"]
): ExtensionManifest {
    return {
        apiVersion: EXTENSION_API_VERSION,
        capabilities: [],
        entry: "extension.mjs",
        extensions,
        hostDependencies: [],
        id,
        name: `${id}-${generation}`,
        schemaVersion: 1,
        version: generation
    };
}

test("Extension catalog validates domain declarations without runtime bindings", () => {
    const catalog = new ExtensionCatalog(createControlExtensionPointRegistry());
    const current = manifest("example", "a", {
        "cli.native-commands": [{ id: "example", summary: "Run example", title: "Example" }],
        "web.applications": [{ id: "example-web", title: "Example Web" }]
    });

    catalog.replace("example", "a", current);

    assert.equal(catalog.getExtension("example")?.manifest.name, "example-a");
    assert.deepEqual(catalog.get("cli.native-commands", "example"), {
        declaration: { id: "example", summary: "Run example", title: "Example" },
        extensionId: "example",
        generation: "a",
        id: "example",
        pointId: "cli.native-commands"
    });
    assert.deepEqual(catalog.get("web.applications", "example-web")?.declaration, {
        id: "example-web",
        title: "Example Web"
    });
});

test("Extension catalog rejects unsupported or invalid point declarations before activation", () => {
    const catalog = new ExtensionCatalog(createControlExtensionPointRegistry());

    assert.throws(
        () => catalog.replace("example", "a", manifest("example", "a", {
            "future.unknown": [{ id: "future" }]
        })),
        /unsupported Extension Point future\.unknown/u
    );
    assert.throws(
        () => catalog.replace("example", "a", manifest("example", "a", {
            "cli.native-commands": [{ id: "example", title: "" }]
        })),
        /title must be a non-empty trimmed string/u
    );
    assert.equal(catalog.getExtension("example"), undefined);
});

test("Extension catalog permits native builtin overlays and independent model commands with the same id", () => {
    const catalog = new ExtensionCatalog(createControlExtensionPointRegistry());
    catalog.replace("overlay", "a", manifest("overlay", "a", {
        "cli.model-commands": [{ id: "status", title: "Model status" }],
        "cli.native-commands": [{ id: "status", title: "Native status" }]
    }));

    assert.equal(catalog.get("cli.native-commands", "status")?.declaration.title, "Native status");
    assert.equal(catalog.get("cli.model-commands", "status")?.declaration.title, "Model status");
});

test("Extension catalog detects conflicts across inactive Extensions and keeps replacement atomic", () => {
    const catalog = new ExtensionCatalog(createControlExtensionPointRegistry());
    catalog.replace("first", "a", manifest("first", "a", {
        "cli.native-commands": [{ id: "shared", title: "First" }]
    }));

    assert.throws(
        () => catalog.replace("second", "a", manifest("second", "a", {
            "cli.native-commands": [{ id: "shared", title: "Second" }]
        })),
        /registration conflict for cli\.native-commands\/shared: second and first/u
    );
    assert.equal(catalog.get("cli.native-commands", "shared")?.extensionId, "first");

    assert.throws(
        () => catalog.replace("first", "b", manifest("first", "b", {
            "cli.native-commands": [{ id: "shared", title: "" }]
        })),
        /title must be a non-empty trimmed string/u
    );
    assert.equal(catalog.getExtension("first")?.generation, "a");
    assert.equal(catalog.get("cli.native-commands", "shared")?.generation, "a");
});

test("Extension catalog replacement and removal update static routing without bindings", () => {
    const catalog = new ExtensionCatalog(createControlExtensionPointRegistry());
    catalog.replace("example", "a", manifest("example", "a", {
        "cli.native-commands": [{ id: "old", title: "Old" }]
    }));
    catalog.replace("example", "b", manifest("example", "b", {
        "cli.native-commands": [{ id: "new", title: "New" }]
    }));

    assert.equal(catalog.get("cli.native-commands", "old"), undefined);
    assert.equal(catalog.get("cli.native-commands", "new")?.generation, "b");

    catalog.remove("example");
    assert.equal(catalog.getExtension("example"), undefined);
    assert.equal(catalog.get("cli.native-commands", "new"), undefined);
});
