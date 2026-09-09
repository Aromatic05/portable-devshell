import assert from "node:assert/strict";
import test from "node:test";

import {
    assertControlExtensionPointRegistryParity,
    createControlExtensionPointRegistry
} from "../../../src/composition/ControlExtensionPointRegistry.ts";
import { createControlExtensionSandboxPointRegistry } from "../../../src/composition/ControlExtensionSandboxPointRegistry.ts";

test("Control composes the same Extension Point ids for host validation and sandbox codecs", () => {
    const points = createControlExtensionPointRegistry();
    const sandbox = createControlExtensionSandboxPointRegistry();

    assert.deepEqual(points.ids(), sandbox.ids());
    assert.deepEqual(points.ids(), [...points.ids()].sort());
});

test("Control rejects a point-definition and sandbox-codec composition drift", () => {
    assert.throws(
        () => assertControlExtensionPointRegistryParity(
            { ids: () => ["cli.commands", "web.applications"] },
            { ids: () => ["cli.commands"] }
        ),
        /registry and sandbox codec registry are out of sync/u
    );
    assert.throws(
        () => assertControlExtensionPointRegistryParity(
            { ids: () => ["cli.commands"] },
            { ids: () => ["cli.commands", "web.applications"] }
        ),
        /registry and sandbox codec registry are out of sync/u
    );
});

test("Control domain point definitions own declaration schema validation", () => {
    const points = createControlExtensionPointRegistry();

    assert.deepEqual(points.parseDeclaration("cli.commands", {
        id: "agent",
        summary: "Run an Agent",
        title: "Agent",
        usage: "agent <command>"
    }, "example"), {
        id: "agent",
        summary: "Run an Agent",
        title: "Agent",
        usage: "agent <command>"
    });
    assert.deepEqual(points.parseDeclaration("web.applications", {
        id: "agent",
        title: "Agent"
    }, "example"), {
        id: "agent",
        title: "Agent"
    });
    assert.throws(
        () => points.parseDeclaration("cli.commands", {
            id: "agent",
            title: "Agent",
            transport: "rpc"
        }, "example"),
        /unknown field/u
    );
    assert.throws(
        () => points.parseDeclaration("web.applications", {
            id: "agent",
            title: " Agent "
        }, "example"),
        /non-empty trimmed string/u
    );
});
