import assert from "node:assert/strict";
import test from "node:test";

import { EXTENSION_API_VERSION } from "@portable-devshell/extension";
import type { ExtensionManifest } from "@portable-devshell/extension";

import { ExtensionGeneration } from "../../../src/control/extension/host/generation/ExtensionGeneration.ts";
import { ExtensionRegistrationSet } from "../../../src/control/extension/host/generation/ExtensionRegistration.ts";

const manifest: ExtensionManifest = {
    apiVersion: EXTENSION_API_VERSION,
    capabilities: [],
    entry: "extension.mjs",
    extensions: {},
    hostDependencies: [],
    id: "example",
    name: "Example",
    schemaVersion: 1,
    version: "1.0.0"
};

const registrations = new ExtensionRegistrationSet([]);

test("Extension generation drains existing leases before disposal and rejects new leases", async () => {
    let disposeCount = 0;
    const generation = new ExtensionGeneration({
        dispose: async () => { disposeCount += 1; },
        generation: "1.0.0-a",
        manifest,
        registrations
    });
    generation.activate();
    const lease = generation.acquire();
    const retired = generation.retire();

    assert.equal(generation.state, "draining");
    assert.equal(generation.inFlight, 1);
    assert.equal(disposeCount, 0);
    assert.throws(() => generation.acquire(), /not active/u);

    lease.release();
    await retired;
    assert.equal(generation.state, "disposed");
    assert.equal(generation.inFlight, 0);
    assert.equal(disposeCount, 1);
    lease.release();
    assert.equal(disposeCount, 1);
});

test("Extension candidate can be retired before it becomes active", async () => {
    let disposed = false;
    const generation = new ExtensionGeneration({
        dispose: async () => { disposed = true; },
        generation: "1.0.0-candidate",
        manifest,
        registrations
    });
    await generation.retire();
    assert.equal(disposed, true);
    assert.equal(generation.state, "disposed");
});

test("Extension generation surfaces disposal failures without double disposal", async () => {
    let disposeCount = 0;
    const failure = new Error("dispose failed");
    const generation = new ExtensionGeneration({
        dispose: async () => {
            disposeCount += 1;
            throw failure;
        },
        generation: "1.0.0-bad-dispose",
        manifest,
        registrations
    });
    generation.activate();
    await assert.rejects(generation.retire(), failure);
    assert.equal(generation.state, "dispose-failed");
    assert.equal(generation.disposeError, failure);
    assert.equal(disposeCount, 1);
    await assert.rejects(generation.retire(), failure);
    assert.equal(disposeCount, 1);
});
