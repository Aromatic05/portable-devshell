import assert from "node:assert/strict";
import test from "node:test";

import { EXTENSION_API_VERSION, EXTENSION_MANIFEST_SCHEMA_VERSION } from "@portable-devshell/extension";

import { ExtensionGeneration } from "../../../../../src/extension/registration/Generation.ts";
import { ExtensionRegistrationSet } from "../../../../../src/extension/registration/Registration.ts";
import { ExtensionRetirementTracker } from "../../../../../src/extension/registration/Retirement.ts";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

function generation(id: string, dispose: () => Promise<void>) {
    return new ExtensionGeneration({
        generation: "same-hash", dispose, registrations: new ExtensionRegistrationSet([]),
        manifest: {
            id, name: id, version: "1.0.0", activation: "lazy", entry: "extension.mjs",
            apiVersion: EXTENSION_API_VERSION, schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
            capabilities: [], extensions: {}, hostDependencies: {},
        },
    });
}

test("retirement keeps actionable failures across drains without blocking unrelated extensions", async () => {
    let attempts = 0;
    let available = false;
    const failure = new Error("external release unavailable");
    const failed = deferred();
    const tracker = new ExtensionRetirementTracker(() => failed.resolve());
    const broken = generation("broken", async () => {
        attempts++;
        if (!available) throw failure;
    });
    tracker.track("broken", broken);
    await failed.promise;
    assert.equal(tracker.has("broken"), true);
    assert.deepEqual(tracker.list("broken"), [{ generation: "same-hash", inFlight: 0, state: "dispose-failed" }]);
    tracker.track("healthy", generation("healthy", async () => {}));
    await tracker.waitForDrain("healthy");
    assert.equal(tracker.has("healthy"), false);
    await assert.rejects(tracker.waitForDrain("broken"), { errors: [failure] });
    await assert.rejects(tracker.drainAll(), { errors: [failure] });
    assert.equal(attempts, 3);
    assert.equal(tracker.has("broken"), true);
    available = true;
    await tracker.waitForDrain("broken");
    assert.equal(attempts, 4);
    assert.equal(tracker.has("broken"), false);
    assert.deepEqual(tracker.list("broken"), []);
    await tracker.drainAll();
    assert.equal(attempts, 4);
});

test("retirement tracks concrete runtimes with the same hash and coalesces concurrent retry drains", async () => {
    const failed = deferred();
    const retry = deferred();
    const started = deferred();
    const tracker = new ExtensionRetirementTracker(() => failed.resolve());
    let attempts = 0;
    tracker.track("probe", generation("probe", async () => {
        attempts++;
        if (attempts === 1) throw new Error("fail once");
        started.resolve();
        await retry.promise;
    }));
    await failed.promise;
    let healthyDisposals = 0;
    tracker.track("probe", generation("probe", async () => { healthyDisposals++; }));
    const first = tracker.waitForDrain("probe");
    await started.promise;
    const second = tracker.drainAll();
    retry.resolve();
    await Promise.all([first, second]);
    assert.equal(attempts, 2);
    assert.equal(healthyDisposals, 1);
    assert.equal(tracker.has("probe"), false);
});
