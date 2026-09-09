import assert from "node:assert/strict";
import test from "node:test";

import {
    EXTENSION_API_VERSION,
    type ExtensionManifest
} from "@portable-devshell/extension";

import { createControlExtensionPointRegistry } from "../../../src/composition/ControlExtensionPointRegistry.ts";
import { ExtensionGeneration } from "../../../src/control/extension/host/generation/ExtensionGeneration.ts";
import { ExtensionRegistrationSet } from "../../../src/control/extension/host/generation/ExtensionRegistration.ts";
import { ExtensionHost, type ExtensionGenerationLoader } from "../../../src/control/extension/host/ExtensionHost.ts";
import {
    cloneExtensionRegistry,
    type ExtensionRegistrySnapshot
} from "../../../src/control/extension/state/ExtensionRegistryModel.ts";
import type { ExtensionRegistryPort } from "../../../src/control/extension/state/ExtensionRegistryStore.ts";

class MemoryRegistry implements ExtensionRegistryPort {
    beforeWrite?: (snapshot: ExtensionRegistrySnapshot) => Promise<void> | void;
    value: ExtensionRegistrySnapshot;

    constructor(value: ExtensionRegistrySnapshot) {
        this.value = cloneExtensionRegistry(value);
    }

    async read(): Promise<ExtensionRegistrySnapshot> {
        return cloneExtensionRegistry(this.value);
    }

    async write(snapshot: ExtensionRegistrySnapshot): Promise<void> {
        await this.beforeWrite?.(snapshot);
        this.value = cloneExtensionRegistry(snapshot);
    }
}

function manifest(id: string, generation: string): ExtensionManifest {
    return {
        apiVersion: EXTENSION_API_VERSION,
        capabilities: [],
        entry: "extension.mjs",
        extensions: {
            "cli.native-commands": [{ id, title: id }]
        },
        hostDependencies: [],
        id,
        name: id,
        schemaVersion: 1,
        version: generation
    };
}

function unregisteredManifest(id: string, generation: string): ExtensionManifest {
    return { ...manifest(id, generation), extensions: {} };
}

function createLoader(
    load: ExtensionGenerationLoader["load"],
    readManifest: ExtensionGenerationLoader["readManifest"] = async (id, generation) => manifest(id, generation)
): ExtensionGenerationLoader {
    return { load, points: createControlExtensionPointRegistry(), readManifest };
}

function generation(
    id: string,
    name: string,
    handler: () => Promise<string> | string,
    disposed: string[]
): ExtensionGeneration {
    return new ExtensionGeneration({
        dispose: async () => { disposed.push(name); },
        generation: name,
        manifest: manifest(id, name),
        registrations: new ExtensionRegistrationSet([{
            binding: async () => await handler(),
            declaration: { id, title: id },
            id,
            pointId: "cli.native-commands"
        }])
    });
}

function unregisteredGeneration(
    id: string,
    name: string,
    dispose: () => Promise<void>,
    retireInstanceResources?: (instance: string) => Promise<void>
): ExtensionGeneration {
    return new ExtensionGeneration({
        dispose,
        generation: name,
        manifest: {
            ...manifest(id, name),
            extensions: {}
        },
        registrations: new ExtensionRegistrationSet([]),
        ...(retireInstanceResources === undefined ? {} : { retireInstanceResources })
    });
}

async function commandText(host: ExtensionHost, id: string, _requestId: string): Promise<string> {
    const { lease, registration } = await host.acquireRegistration("cli.native-commands", id);
    try {
        assert.equal(typeof registration.binding, "function");
        return await (registration.binding as () => Promise<string>)();
    } finally {
        lease.release();
    }
}

test("Extension host swaps atomically while an old in-flight request drains on its original generation", async () => {
    const registry = new MemoryRegistry({
        extensions: { example: { enabled: true, lastKnownGoodGeneration: "a", selectedGeneration: "a" } },
        schemaVersion: 1
    });
    const disposed: string[] = [];
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const loader = createLoader(async (id, name) => {
        if (name === "a") {
            return generation(id, name, async () => {
                await oldGate;
                return "old";
            }, disposed);
        }
        return generation(id, name, () => "new", disposed);
    });
    const host = new ExtensionHost({ loader, registry });
    await host.start();

    const oldRequest = commandText(host, "example", "old-request");
    await host.activateGeneration("example", "b");

    assert.equal(await commandText(host, "example", "new-request"), "new");
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

test("Extension host rejects a static registration conflict before loading candidate code", async () => {
    const registry = new MemoryRegistry({
        extensions: {
            first: { enabled: true, selectedGeneration: "a" },
            second: { enabled: false, selectedGeneration: "b" }
        },
        schemaVersion: 1
    });
    const loaded: string[] = [];
    const loader = createLoader(
        async (id, name) => {
            loaded.push(`${id}:${name}`);
            return generation(id, name, () => id, []);
        },
        async (id, name) => id === "second"
            ? {
                ...manifest(id, name),
                extensions: { "cli.native-commands": [{ id: "first", title: "Conflicting" }] }
            }
            : manifest(id, name)
    );
    const host = new ExtensionHost({ loader, registry });
    await host.start();

    await assert.rejects(
        host.activateGeneration("second", "b"),
        /registration conflict for cli\.native-commands\/first: second and first/u
    );
    assert.deepEqual(loaded, []);
    await host.stop();
});

test("Extension candidate failure leaves the active generation and registry selection untouched", async () => {
    const registry = new MemoryRegistry({
        extensions: { example: { enabled: true, lastKnownGoodGeneration: "a", selectedGeneration: "a" } },
        schemaVersion: 1
    });
    const disposed: string[] = [];
    const loader = createLoader(async (id, name) => {
        if (name === "bad") throw new Error("candidate failed");
        return generation(id, name, () => name, disposed);
    });
    const host = new ExtensionHost({ loader, registry });
    await host.start();
    assert.equal(await commandText(host, "example", "activate-old"), "a");
    await assert.rejects(host.activateGeneration("example", "bad"), /candidate failed/u);
    assert.equal(await commandText(host, "example", "still-old"), "a");
    assert.equal((await host.list())[0]?.activeGeneration, "a");
    assert.equal(registry.value.extensions.example?.selectedGeneration, "a");
    await host.stop();
});

test("Extension candidate fault during registry commit rolls back selection and preserves the old active generation", async () => {
    const registry = new MemoryRegistry({
        extensions: { example: { enabled: true, lastKnownGoodGeneration: "a", selectedGeneration: "a" } },
        schemaVersion: 1
    });
    const disposed: string[] = [];
    let candidateB: ExtensionGeneration | undefined;
    const host = new ExtensionHost({
        loader: createLoader(async (id, name) => {
            const candidate = generation(id, name, () => name, disposed);
            if (name === "b") candidateB = candidate;
            return candidate;
        }),
        registry
    });
    await host.start();
    assert.equal(await commandText(host, "example", "activate-old"), "a");
    registry.beforeWrite = (snapshot) => {
        if (snapshot.extensions.example?.selectedGeneration !== "b") return;
        registry.beforeWrite = undefined;
        candidateB!.fault(new Error("candidate crashed during commit"));
    };

    await assert.rejects(host.activateGeneration("example", "b"), /candidate crashed during commit/u);
    assert.equal(registry.value.extensions.example?.selectedGeneration, "a");
    assert.equal((await host.list())[0]?.activeGeneration, "a");
    assert.equal(await commandText(host, "example", "old-still-active"), "a");
    assert.ok(disposed.includes("b"));
    await host.stop();
});

test("Extension registry commit failure preserves candidate cleanup failure", async () => {
    const registry = new MemoryRegistry({
        extensions: { example: { enabled: true, lastKnownGoodGeneration: "a", selectedGeneration: "a" } },
        schemaVersion: 1
    });
    const host = new ExtensionHost({
        loader: createLoader(async (id, name) => {
            if (name !== "b") return generation(id, name, () => name, []);
            return unregisteredGeneration(
                id,
                name,
                async () => { throw new Error("candidate cleanup failed"); }
            );
        }),
        registry
    });
    await host.start();
    assert.equal(await commandText(host, "example", "activate-old"), "a");
    registry.beforeWrite = (snapshot) => {
        if (snapshot.extensions.example?.selectedGeneration === "b") throw new Error("registry write failed");
    };

    await assert.rejects(
        host.activateGeneration("example", "b"),
        (error: unknown) => error instanceof AggregateError
            && error.errors.map((candidate) => candidate instanceof Error ? candidate.message : String(candidate)).join("|")
                === "registry write failed|candidate cleanup failed"
    );
    assert.equal(registry.value.extensions.example?.selectedGeneration, "a");
    assert.equal((await host.list())[0]?.activeGeneration, "a");
    await host.stop();
});

test("Extension first-use activation falls back to last-known-good when the selected candidate faults", async () => {
    const registry = new MemoryRegistry({
        extensions: {
            example: { enabled: true, lastKnownGoodGeneration: "good", selectedGeneration: "broken" }
        },
        schemaVersion: 1
    });
    const loaded: string[] = [];
    let broken: ExtensionGeneration | undefined;
    registry.beforeWrite = (snapshot) => {
        if (snapshot.extensions.example?.selectedGeneration !== "broken" || broken === undefined) return;
        registry.beforeWrite = undefined;
        broken.fault(new Error("selected candidate crashed"));
    };
    const host = new ExtensionHost({
        loader: createLoader(async (id, name) => {
            loaded.push(name);
            const candidate = generation(id, name, () => name, []);
            if (name === "broken") broken = candidate;
            return candidate;
        }),
        registry
    });

    await host.start();

    assert.deepEqual(loaded, []);
    assert.equal((await host.list())[0]?.state, "installed");
    assert.equal(await commandText(host, "example", "lazy-fallback"), "good");
    assert.deepEqual(loaded, ["broken", "good"]);
    assert.equal(registry.value.extensions.example?.selectedGeneration, "good");
    assert.equal((await host.list())[0]?.activeGeneration, "good");
    await host.stop();
});

test("Extension lazy activation does not treat registry persistence failure as a last-known-good candidate failure", async () => {
    const registry = new MemoryRegistry({
        extensions: {
            example: { enabled: true, lastKnownGoodGeneration: "good", selectedGeneration: "selected" }
        },
        schemaVersion: 1
    });
    const loaded: string[] = [];
    registry.beforeWrite = () => { throw new Error("registry disk failure"); };
    const host = new ExtensionHost({
        loader: createLoader(async (id, name) => {
            loaded.push(name);
            return generation(id, name, () => name, []);
        }),
        registry
    });

    await host.start();

    assert.deepEqual(loaded, []);
    await assert.rejects(commandText(host, "example", "registry-failure"), /registry disk failure/u);
    assert.deepEqual(loaded, ["selected"]);
    const record = (await host.list())[0]!;
    assert.equal(record.state, "failed");
    assert.match(record.failure?.message ?? "", /registry disk failure/u);
    assert.equal(registry.value.extensions.example?.selectedGeneration, "selected");
    await host.stop();
});

test("Extension startup catalogs last-known-good when the selected manifest is unavailable without activating code", async () => {
    const registry = new MemoryRegistry({
        extensions: {
            bad: { enabled: true, lastKnownGoodGeneration: "good", selectedGeneration: "broken" },
            healthy: { enabled: true, selectedGeneration: "v1" }
        },
        schemaVersion: 1
    });
    const disposed: string[] = [];
    const loaded: string[] = [];
    const manifestReads: string[] = [];
    const loader = createLoader(
        async (id, name) => {
            loaded.push(`${id}:${name}`);
            return generation(id, name, () => `${id}:${name}`, disposed);
        },
        async (id, name) => {
            manifestReads.push(`${id}:${name}`);
            if (id === "bad" && name === "broken") throw new Error("broken manifest");
            return manifest(id, name);
        }
    );
    const host = new ExtensionHost({ loader, registry });

    await host.start();

    const records = await host.list();
    assert.deepEqual(loaded, []);
    assert.deepEqual(manifestReads, ["bad:broken", "bad:good", "healthy:v1"]);
    assert.deepEqual(
        host.listDeclarations("cli.native-commands").map((registration) => ({
            extensionId: registration.extensionId,
            id: registration.id
        })),
        [
            { extensionId: "bad", id: "bad" },
            { extensionId: "healthy", id: "healthy" }
        ]
    );
    assert.deepEqual(loaded, []);
    assert.equal(records.find((record) => record.id === "bad")?.activeGeneration, undefined);
    assert.equal(records.find((record) => record.id === "bad")?.state, "installed");
    assert.equal(records.find((record) => record.id === "healthy")?.activeGeneration, undefined);
    assert.equal(records.find((record) => record.id === "healthy")?.state, "installed");
    assert.equal(registry.value.extensions.bad?.selectedGeneration, "good");
    assert.equal(registry.value.extensions.bad?.lastKnownGoodGeneration, "good");
    assert.equal(await commandText(host, "bad", "activate-bad"), "bad:good");
    assert.equal(await commandText(host, "healthy", "activate-healthy"), "healthy:v1");
    assert.deepEqual(loaded, ["bad:good", "healthy:v1"]);
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
        loader: createLoader(async (id, name) => generation(id, name, async () => {
            await gate;
            return "done";
        }, disposed)),
        registry
    });
    await host.start();
    const active = commandText(host, "example", "leased");

    await host.disable("example");
    await assert.rejects(
        host.acquireRegistration("cli.native-commands", "example"),
        /No Extension registration/u
    );
    assert.equal((await host.list())[0]?.state, "disabled");
    release();
    await active;
    await waitFor(() => disposed.includes("a"));
    await host.stop();
});

test("Extension enable validates and publishes the static catalog without activating code", async () => {
    const registry = new MemoryRegistry({
        extensions: { example: { enabled: false, selectedGeneration: "a" } },
        schemaVersion: 1
    });
    let manifestFailure = true;
    const loaded: string[] = [];
    const host = new ExtensionHost({
        loader: createLoader(
            async (id, name) => {
                loaded.push(name);
                return generation(id, name, () => "enabled", []);
            },
            async (id, name) => {
                if (manifestFailure) throw new Error("enable manifest failed");
                return manifest(id, name);
            }
        ),
        registry
    });
    await host.start();

    await assert.rejects(host.enable("example"), /enable manifest failed/u);
    assert.equal(registry.value.extensions.example?.enabled, false);
    assert.equal((await host.list())[0]?.state, "disabled");
    assert.deepEqual(loaded, []);

    manifestFailure = false;
    await host.enable("example");
    assert.equal(registry.value.extensions.example?.enabled, true);
    assert.equal((await host.list())[0]?.state, "installed");
    assert.deepEqual(loaded, []);
    assert.equal(await commandText(host, "example", "enabled"), "enabled");
    assert.deepEqual(loaded, ["a"]);
    assert.equal((await host.list())[0]?.state, "active");
    await host.stop();
});

test("Extension host reports a faulted active generation as failed and rejects new leases", async () => {
    const registry = new MemoryRegistry({
        extensions: { example: { enabled: true, selectedGeneration: "a" } },
        schemaVersion: 1
    });
    let loaded: ExtensionGeneration | undefined;
    const host = new ExtensionHost({
        loader: createLoader(async (id, name) => {
            loaded = generation(id, name, () => "ok", []);
            return loaded;
        }),
        registry
    });
    await host.start();
    assert.equal(await commandText(host, "example", "activate"), "ok");
    loaded!.fault(new Error("sandbox OOM"));

    const record = (await host.list())[0]!;
    assert.equal(record.state, "failed");
    assert.equal(record.activeGeneration, "a");
    assert.equal(record.failure?.message, "sandbox OOM");
    await assert.rejects(
        host.acquireRegistration("cli.native-commands", "example"),
        /sandbox OOM/u
    );
    await host.stop();
});

test("Extension host waits for every instance resource retirement even when another generation fails", async () => {
    const registry = new MemoryRegistry({
        extensions: {
            failing: { enabled: true, selectedGeneration: "a" },
            healthy: { enabled: true, selectedGeneration: "a" }
        },
        schemaVersion: 1
    });
    let releaseHealthy!: () => void;
    const healthyGate = new Promise<void>((resolve) => { releaseHealthy = resolve; });
    let healthyCompleted = false;
    const host = new ExtensionHost({
        loader: createLoader(
            async (id, name) => unregisteredGeneration(
                id,
                name,
                async () => undefined,
                id === "healthy"
                    ? async () => {
                        await healthyGate;
                        healthyCompleted = true;
                    }
                    : async () => { throw new Error("resource retirement failed"); }
            ),
            async (id, name) => unregisteredManifest(id, name)
        ),
        registry
    });
    await host.start();
    await host.reload("failing");
    await host.reload("healthy");

    let settled = false;
    const retirement = host.retireInstanceResources("local").then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error })
    ).finally(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(healthyCompleted, false);

    releaseHealthy();
    const result = await retirement;
    assert.equal(healthyCompleted, true);
    assert.ok(result.error instanceof AggregateError);
    assert.ok(result.error.errors.some((error) => (
        error instanceof Error
        && /failed to retire resources/u.test(error.message)
        && error.cause instanceof Error
        && /resource retirement failed/u.test(error.cause.message)
    )));
    await host.stop();
});

test("Extension host preserves a fast retirement failure until waitForDrain observes it", async () => {
    const registry = new MemoryRegistry({
        extensions: { example: { enabled: true, selectedGeneration: "a" } },
        schemaVersion: 1
    });
    const host = new ExtensionHost({
        loader: createLoader(
            async (id, name) => unregisteredGeneration(
                id,
                name,
                async () => { throw new Error("fast dispose failure"); }
            ),
            async (id, name) => unregisteredManifest(id, name)
        ),
        registry
    });
    await host.start();
    await host.reload("example");
    await host.disable("example");
    await new Promise<void>((resolve) => setImmediate(resolve));

    await assert.rejects(host.forget("example"), /still has active or draining generations/u);
    await assert.rejects(
        host.waitForDrain("example"),
        (error: unknown) => aggregateContains(error, /fast dispose failure/u)
    );
    await host.forget("example");
    assert.deepEqual(await host.list(), []);
    await host.stop();
});

test("Extension host stop reports a retirement failure even when it settles before the stop snapshot", async () => {
    const registry = new MemoryRegistry({
        extensions: { example: { enabled: true, selectedGeneration: "a" } },
        schemaVersion: 1
    });
    const host = new ExtensionHost({
        loader: createLoader(
            async (id, name) => unregisteredGeneration(
                id,
                name,
                async () => { throw new Error("stop dispose failure"); }
            ),
            async (id, name) => unregisteredManifest(id, name)
        ),
        registry
    });
    await host.start();
    await host.reload("example");

    await assert.rejects(
        host.stop(),
        (error: unknown) => aggregateContains(error, /stop dispose failure/u)
    );
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for Extension state transition.");
}

function aggregateContains(error: unknown, pattern: RegExp): boolean {
    return error instanceof AggregateError
        && error.errors.some((candidate) => candidate instanceof Error && pattern.test(candidate.message));
}
