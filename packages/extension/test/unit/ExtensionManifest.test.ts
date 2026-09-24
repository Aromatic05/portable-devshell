import assert from "node:assert/strict";
import test from "node:test";

import {
    EXTENSION_API_VERSION,
    EXTENSION_MANIFEST_SCHEMA_VERSION,
    parseExtensionManifest,
} from "../../src/index.ts";

const base = {
    activation: "lazy" as const,
    apiVersion: EXTENSION_API_VERSION,
    capabilities: [] as string[],
    entry: "extension.mjs",
    id: "example",
    name: "Example",
    schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
    version: "1.0.0",
};

test("Extension manifest accepts only the resource capability taxonomy and static point declarations", () => {
    assert.deepEqual(
        parseExtensionManifest({
            ...base,
            capabilities: [
                "artifacts",
                "assets",
                "delegatedWorkers",
                "instances",
                "workers",
                "processes",
            ],
            extensions: {
                "cli.native-commands": [
                    {
                        id: "example",
                        summary: "Run the example",
                        title: "Example",
                    },
                ],
                "web.applications": [{ id: "example", title: "Example" }],
            },
            hostDependencies: ["@modelcontextprotocol/client"],
        }),
        {
            ...base,
            capabilities: [
                "artifacts",
                "assets",
                "delegatedWorkers",
                "instances",
                "workers",
                "processes",
            ],
            extensions: {
                "cli.native-commands": [
                    {
                        id: "example",
                        summary: "Run the example",
                        title: "Example",
                    },
                ],
                "web.applications": [{ id: "example", title: "Example" }],
            },
            hostDependencies: ["@modelcontextprotocol/client"],
        },
    );
});

test("Extension manifest parses owned Config schema and declared Core access", () => {
    const config = {
        access: { "mcp.publicBaseUrl": "read" },
        default: { enabled: false },
        schema: {
            additionalProperties: false,
            properties: { enabled: { type: "boolean" } },
            required: ["enabled"],
            type: "object",
        },
    };

    assert.deepEqual(parseExtensionManifest({ ...base, config }).config, config);
    assert.deepEqual(
        parseExtensionManifest({
            ...base,
            config: { access: { "mcp.listenPort": "read" } },
        }).config,
        { access: { "mcp.listenPort": "read" } },
    );
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                config: { default: false, schema: true },
            }),
        /config\.default/u,
    );
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                config: { default: {}, schema: [] },
            }),
        /config\.schema/u,
    );
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                config: { default: {}, extra: true, schema: true },
            }),
        /Unknown Extension manifest field/u,
    );
    assert.throws(
        () => parseExtensionManifest({ ...base, config: { default: {} } }),
        /config\.schema/u,
    );
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                config: { access: { mcp: "read" } },
            }),
        /access path/u,
    );
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                config: { access: { "mcp.listenPort": "write" } },
            }),
        /must be read or read-write/u,
    );
    assert.throws(
        () => parseExtensionManifest({ ...base, config: { access: {} } }),
        /must not be empty/u,
    );
});

test("delegatedWorkers is an independent controlled Worker capability", () => {
    assert.deepEqual(
        parseExtensionManifest({ ...base, capabilities: ["delegatedWorkers"] })
            .capabilities,
        ["delegatedWorkers"],
    );
});

test("Extension manifest requires activation in schema 1.1+ and defaults schema 1.0 to lazy", () => {
    assert.equal(
        parseExtensionManifest({ ...base, activation: "eager" }).activation,
        "eager",
    );
    assert.throws(
        () => parseExtensionManifest({ ...base, activation: "startup" }),
        /activation/u,
    );
    const { activation: _activation, ...withoutActivation } = base;
    assert.throws(
        () => parseExtensionManifest(withoutActivation),
        /activation/u,
    );
    assert.equal(
        parseExtensionManifest({
            ...withoutActivation,
            schemaVersion: "1.0.0",
        }).activation,
        "lazy",
    );
});

test("Extension manifest does not preserve the unreleased v2 or contribution-as-capability ABI", () => {
    assert.throws(
        () => parseExtensionManifest({ ...base, apiVersion: 2 }),
        /apiVersion/u,
    );
    for (const capability of [
        "command",
        "rpc",
        "web",
        "worker",
        "child-process",
        "instance-lifecycle",
        "comment",
    ]) {
        assert.throws(
            () =>
                parseExtensionManifest({ ...base, capabilities: [capability] }),
            /Unknown Extension capability/u,
        );
    }
});

test("Extension manifest rejects invalid ids, escaping entry paths and duplicate capabilities", () => {
    assert.throws(
        () => parseExtensionManifest({ ...base, id: "Bad_ID" }),
        /id/u,
    );
    assert.throws(
        () => parseExtensionManifest({ ...base, entry: "../escape.mjs" }),
        /entry/u,
    );
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                capabilities: ["assets", "assets"],
            }),
        /duplicate/u,
    );
});

test("Extension manifest validates Extension Point identities and declaration-local identities", () => {
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                extensions: { cli: [{ id: "example" }] },
            }),
        /Extension Point id/u,
    );
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                extensions: { "cli.native-commands": [{ id: "Bad_ID" }] },
            }),
        /cli\.native-commands/u,
    );
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                extensions: {
                    "cli.native-commands": [
                        { id: "example" },
                        { id: "example" },
                    ],
                },
            }),
        /duplicate ids/u,
    );
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                extensions: { "cli.native-commands": { id: "example" } },
            }),
        /must be an array/u,
    );
});

test("Extension manifest defaults extensions and hostDependencies to empty collections", () => {
    assert.deepEqual(parseExtensionManifest(base).extensions, {});
    assert.deepEqual(parseExtensionManifest(base).hostDependencies, []);
});

test("Extension manifest accepts compatible same-major versions and legacy integers", () => {
    assert.equal(
        parseExtensionManifest({
            ...base,
            apiVersion: "4.0.0",
            schemaVersion: "1.1.0",
        }).apiVersion,
        "4.0.0",
    );
    const { activation: _activation, ...legacyBase } = base;
    assert.equal(
        parseExtensionManifest({
            ...legacyBase,
            apiVersion: 4,
            schemaVersion: 1,
        }).schemaVersion,
        "1.0.0",
    );
    assert.throws(
        () => parseExtensionManifest({ ...base, apiVersion: "4.2.0" }),
        /apiVersion/u,
    );
    assert.throws(
        () => parseExtensionManifest({ ...base, apiVersion: "5.0.0" }),
        /apiVersion/u,
    );
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                schemaVersion: "1.0.0",
                config: { access: { "mcp.listenPort": "read" } },
                activation: undefined,
            }),
        /Unknown Extension manifest field/u,
    );
});

test("Extension manifest rejects unknown fields and unsupported schema versions", () => {
    assert.throws(
        () => parseExtensionManifest({ ...base, extra: true }),
        /Unknown/u,
    );
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                schemaVersion: "1.2.0",
            }),
        /schemaVersion/u,
    );
});

test("Extension manifest validates host dependency package roots", () => {
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                hostDependencies: ["@portable-devshell/control"],
            }),
        /internal packages/u,
    );
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                hostDependencies: ["smol-toml/parser"],
            }),
        /host dependency/u,
    );
    assert.throws(
        () =>
            parseExtensionManifest({
                ...base,
                hostDependencies: ["smol-toml", "smol-toml"],
            }),
        /duplicates/u,
    );
});
