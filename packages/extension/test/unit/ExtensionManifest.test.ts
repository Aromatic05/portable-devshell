import assert from "node:assert/strict";
import test from "node:test";

import {
    EXTENSION_API_VERSION,
    EXTENSION_MANIFEST_SCHEMA_VERSION,
    parseExtensionManifest
} from "../../src/index.ts";

test("Extension manifest parser accepts the v1 contract", () => {
    assert.deepEqual(parseExtensionManifest({
        apiVersion: EXTENSION_API_VERSION,
        capabilities: ["rpc", "worker", "web", "data"],
        entry: "./extension.mjs",
        id: "agent",
        name: "Agent",
        schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
        version: "0.1.0"
    }), {
        apiVersion: 1,
        capabilities: ["rpc", "worker", "web", "data"],
        entry: "./extension.mjs",
        id: "agent",
        name: "Agent",
        schemaVersion: 1,
        version: "0.1.0"
    });
});

test("Extension manifest parser rejects invalid ids, escaping entry paths and duplicate capabilities", () => {
    const base = {
        apiVersion: 1,
        capabilities: ["rpc"],
        entry: "./extension.mjs",
        id: "example",
        name: "Example",
        schemaVersion: 1,
        version: "1.0.0"
    };
    assert.throws(() => parseExtensionManifest({ ...base, id: "Bad_ID" }), /id/u);
    assert.throws(() => parseExtensionManifest({ ...base, entry: "../escape.mjs" }), /entry/u);
    assert.throws(() => parseExtensionManifest({ ...base, capabilities: ["rpc", "rpc"] }), /duplicate/u);
});

test("Extension manifest parser rejects unknown fields and unsupported schema versions", () => {
    const base = {
        apiVersion: 1,
        capabilities: [],
        entry: "extension.mjs",
        id: "example",
        name: "Example",
        schemaVersion: 1,
        version: "1.0.0"
    };
    assert.throws(() => parseExtensionManifest({ ...base, extra: true }), /Unknown/u);
    assert.throws(() => parseExtensionManifest({ ...base, schemaVersion: 2 }), /schemaVersion/u);
});
