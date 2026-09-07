import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionActivation, ExtensionManifest, ExtensionRpcHandler } from "@portable-devshell/extension";

import { ExtensionGeneration } from "../../../src/control/extension/ExtensionGeneration.ts";
import { ExtensionHost, type ExtensionGenerationLoader } from "../../../src/control/extension/ExtensionHost.ts";
import {
    cloneExtensionRegistry,
    type ExtensionRegistrySnapshot
} from "../../../src/control/extension/ExtensionRegistryModel.ts";
import type { ExtensionRegistryPort } from "../../../src/control/extension/ExtensionRegistryStore.ts";

class MemoryRegistry implements ExtensionRegistryPort {
    value: ExtensionRegistrySnapshot;

    constructor(value: ExtensionRegistrySnapshot) {
        this.value = cloneExtensionRegistry(value);
    }

    async read(): Promise<ExtensionRegistrySnapshot> {
        return cloneExtensionRegistry(this.value);
    }

    async write(snapshot: ExtensionRegistrySnapshot): Promise<void> {
        this.value = cloneExtensionRegistry(snapshot);
    }
}

function manifest(id: string, generation: string): ExtensionManifest {
    return {
        apiVersion: 1,
        capabilities: ["rpc"],
        entry: "extension.mjs",
        id,
        name: id,
        schemaVersion: 1,
        version: generation
    };
}

function generation(
    id: string,
    name: string,
    handler: ExtensionRpcHandler,
    disposed: string[]
): ExtensionGeneration {
    const activation: ExtensionActivation = {
        dispose() {},
        rpc: { read: handler }
    };
    return new ExtensionGeneration({
        activation,
        dispose: async () => {
            await activation.dispose();
            disposed.push(name);
        },
        generation: name,
        manifest: manifest(id, name)
    });
}

test("Extension host swaps atomically while an old in-flight request drains on its original generation", async () => {
    const registry = new MemoryRegistry({
        extensions: { example: { enabled: true, lastKnownGoodGeneration: "a", selectedGeneration: "a" } },
        schemaVersion: 1
    });
    const disposed: string[] = [];
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const loader: ExtensionGenerationLoader = {
        async load(id, name) {
            if (name === "a") {
                return generation(id, name, async () => {
                    await oldGate;
                    return "old";
                }, disposed);
            }
            return generation(id, name, async () => "new", disposed);
        }
    };
    const host = new ExtensionHost({ loader, registry });
    await host.start();

    const controller = new AbortController();
    const oldRequest = host.dispatchRpc("example", "read", undefined, {
        localOwner: false,
        requestId: "old-request",
        signal: controller.signal
    });
    await host.activateGeneration("example", "b");

    assert.equal(await host.dispatchRpc("example", "read", undefined, {
        localOwner: false,
        requestId: "new-request",
        signal: controller.signal
    }), "new");
    assert.equal(disposed.length, 0);
    const record = (await host.list())[0]!;
    assert.equal(record.activeGeneration, "b");
    assert.deepEqual(record.retired, [{ generation: "a", inFlight: 1, state: "draining" }]);

    releaseOld();
    assert.equal(await oldRequest, "old");
    await waitFor(() => disposed.includes("a"));
    assert.deepEqual(disposed, ["a"]);
    await host.stop();
});

test("Extension candidate failure leaves the active generation and registry selection untouched", async () => {
    const registry = new MemoryRegistry({
        extensions: { example: { enabled: true, lastKnownGoodGeneration: "a", selectedGeneration: "a" } },
        schemaVersion: 1
    });
    const disposed: string[] = [];
    const loader: ExtensionGenerationLoader = {
        async load(id, name) {
            if (name === "bad") throw new Error("candidate failed");
            return generation(id, name, async () => name, disposed);
        }
    };
    const host = new ExtensionHost({ loader, registry });
    await host.start();
    await assert.rejects(host.activateGeneration("example", "bad"), /candidate failed/u);
    assert.equal(await host.dispatchRpc("example", "read", undefined, {
        localOwner: false,
        requestId: "still-old",
        signal: new AbortController().signal
    }), "a");
    assert.equal((await host.list())[0]?.activeGeneration, "a");
    assert.equal(registry.value.extensions.example?.selectedGeneration, "a");
    await host.stop();
});

test("Extension startup falls back to last-known-good without preventing Control startup", async () => {
    const registry = new MemoryRegistry({
        extensions: {
            bad: { enabled: true, lastKnownGoodGeneration: "good", selectedGeneration: "broken" },
            healthy: { enabled: true, selectedGeneration: "v1" }
        },
        schemaVersion: 1
    });
    const disposed: string[] = [];
    const loader: ExtensionGenerationLoader = {
        async load(id, name) {
            if (id === "bad" && name === "broken") throw new Error("broken extension");
            return generation(id, name, async () => `${id}:${name}`, disposed);
        }
    };
    const host = new ExtensionHost({ loader, registry });

    await host.start();

    const records = await host.list();
    assert.equal(records.find((record) => record.id === "bad")?.activeGeneration, "good");
    assert.equal(records.find((record) => record.id === "healthy")?.activeGeneration, "v1");
    assert.equal(registry.value.extensions.bad?.selectedGeneration, "good");
    assert.equal(registry.value.extensions.bad?.lastKnownGoodGeneration, "good");
    await host.stop();
});

test("Extension disable removes new routing immediately while a leased old generation drains", async () => {
    const registry = new MemoryRegistry({
        extensions: { example: { enabled: true, selectedGeneration: "a" } },
        schemaVersion: 1
    });
    const disposed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = new ExtensionHost({
        loader: {
            async load(id, name) {
                return generation(id, name, async () => {
                    await gate;
                    return "done";
                }, disposed);
            }
        },
        registry
    });
    await host.start();
    const active = host.dispatchRpc("example", "read", undefined, {
        localOwner: false,
        requestId: "leased",
        signal: new AbortController().signal
    });

    await host.disable("example");
    await assert.rejects(
        host.dispatchRpc("example", "read", undefined, {
            localOwner: false,
            requestId: "new",
            signal: new AbortController().signal
        }),
        /not active/u
    );
    assert.equal((await host.list())[0]?.state, "disabled");
    release();
    await active;
    await waitFor(() => disposed.includes("a"));
    await host.stop();
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for Extension state transition.");
}
