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
