import assert from "node:assert/strict";
import test from "node:test";

import {
    EXTENSION_API_VERSION,
    EXTENSION_MANIFEST_SCHEMA_VERSION,
    parseExtensionManifest
} from "../../src/index.ts";

const base = {
    apiVersion: EXTENSION_API_VERSION,
    capabilities: [] as string[],
    entry: "extension.mjs",
    id: "example",
    name: "Example",
    schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
    version: "1.0.0"
};

test("Extension manifest accepts only the resource capability taxonomy and static point declarations", () => {
    assert.deepEqual(parseExtensionManifest({
        ...base,
        capabilities: ["artifacts", "assets", "instances", "workers", "processes"],
        extensions: {
            "cli.native-commands": [{ id: "example", summary: "Run the example", title: "Example" }],
            "web.applications": [{ id: "example", title: "Example" }]
        },
        hostDependencies: ["@modelcontextprotocol/client"]
    }), {
        ...base,
        capabilities: ["artifacts", "assets", "instances", "workers", "processes"],
        extensions: {
            "cli.native-commands": [{ id: "example", summary: "Run the example", title: "Example" }],
            "web.applications": [{ id: "example", title: "Example" }]
        },
        hostDependencies: ["@modelcontextprotocol/client"]
    });
});

test("Extension manifest does not preserve the unreleased v2 or contribution-as-capability ABI", () => {
    assert.throws(() => parseExtensionManifest({ ...base, apiVersion: 2 }), /apiVersion/u);
    for (const capability of ["command", "rpc", "web", "worker", "child-process", "instance-lifecycle"]) {
        assert.throws(
            () => parseExtensionManifest({ ...base, capabilities: [capability] }),
            /Unknown Extension capability/u
        );
    }
});

test("Extension manifest rejects invalid ids, escaping entry paths and duplicate capabilities", () => {
    assert.throws(() => parseExtensionManifest({ ...base, id: "Bad_ID" }), /id/u);
    assert.throws(() => parseExtensionManifest({ ...base, entry: "../escape.mjs" }), /entry/u);
    assert.throws(() => parseExtensionManifest({ ...base, capabilities: ["assets", "assets"] }), /duplicate/u);
});

test("Extension manifest validates Extension Point identities and declaration-local identities", () => {
    assert.throws(
        () => parseExtensionManifest({ ...base, extensions: { cli: [{ id: "example" }] } }),
        /Extension Point id/u
    );
    assert.throws(
        () => parseExtensionManifest({ ...base, extensions: { "cli.native-commands": [{ id: "Bad_ID" }] } }),
        /cli\.native-commands/u
    );
    assert.throws(
        () => parseExtensionManifest({
            ...base,
            extensions: { "cli.native-commands": [{ id: "example" }, { id: "example" }] }
        }),
        /duplicate ids/u
    );
    assert.throws(
        () => parseExtensionManifest({ ...base, extensions: { "cli.native-commands": { id: "example" } } }),
        /must be an array/u
    );
});

test("Extension manifest defaults extensions and hostDependencies to empty collections", () => {
    assert.deepEqual(parseExtensionManifest(base).extensions, {});
    assert.deepEqual(parseExtensionManifest(base).hostDependencies, []);
});

test("Extension manifest rejects unknown fields and unsupported schema versions", () => {
    assert.throws(() => parseExtensionManifest({ ...base, extra: true }), /Unknown/u);
    assert.throws(() => parseExtensionManifest({ ...base, schemaVersion: 2 }), /schemaVersion/u);
});

test("Extension manifest validates host dependency package roots", () => {
    assert.throws(
        () => parseExtensionManifest({ ...base, hostDependencies: ["@portable-devshell/control"] }),
        /internal packages/u
    );
    assert.throws(
        () => parseExtensionManifest({ ...base, hostDependencies: ["smol-toml/parser"] }),
        /host dependency/u
    );
    assert.throws(
        () => parseExtensionManifest({ ...base, hostDependencies: ["smol-toml", "smol-toml"] }),
        /duplicates/u
    );
});
