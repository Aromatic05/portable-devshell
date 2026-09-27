import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { AgentProvider } from "../../src/builtin/provider/AgentProvider.ts";
import {
    AgentProviderManager,
    type AgentProviderDefinition,
} from "../../src/builtin/provider/AgentProviderManager.ts";
import { AgentProviderRegistry } from "../../src/builtin/provider/AgentProviderRegistry.ts";
import { AgentProviderRegistryStore } from "../../src/builtin/provider/AgentProviderRegistryStore.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("Provider manager exposes known adapters as uninstalled until the client installs them", async (t) => {
    const h = await harness(t);

    assert.deepEqual(
        (await h.manager.list()).map(({ id, state }) => ({ id, state })),
        [
            { id: "opencode", state: "uninstalled" },
            { id: "pi", state: "uninstalled" },
        ],
    );

    const installed = await h.manager.install("pi");
    assert.equal(installed.state, "ready");
    assert.equal(installed.installedVersion, "0.1.3");
    assert.equal(h.registry.require("pi").version, "0.1.3");
    assert.equal(await h.manager.resolveProvider(), "pi");
    assert.equal((await h.store.read()).defaultProvider, "pi");
});

test("Provider manager restores enabled client runtimes and upgrades schema v1 state without generation ownership", async (t) => {
    const h = await harness(t);
    h.setInstalled("pi", true);
    await writeFile(
        h.registryPath,
        JSON.stringify({
            defaultProvider: "pi",
            providers: {
                pi: {
                    enabled: true,
                    lastKnownGoodGeneration: "legacy-good",
                    selectedGeneration: "legacy-selected",
                },
            },
            schemaVersion: 1,
        }),
        "utf8",
    );

    await h.manager.initialize();
    assert.equal(h.registry.require("pi").version, "0.1.3");
    assert.equal(await h.manager.resolveProvider(), "pi");

    await h.manager.disable("pi");
    const snapshot = await h.store.read();
    assert.equal(snapshot.schemaVersion, 2);
    assert.deepEqual(snapshot.providers.pi, { enabled: false });
});

test("Provider enable, update, default selection, and removal preserve runtime safety", async (t) => {
    const h = await harness(t);
    await h.manager.install("pi");
    await h.manager.install("opencode");
    assert.equal(await h.manager.setDefault("opencode"), "opencode");
    assert.equal(await h.manager.resolveProvider(), "opencode");

    const disabled = await h.manager.disable("opencode");
    assert.equal(disabled.state, "disabled");
    assert.equal(h.registry.get("opencode"), undefined);
    const enabled = await h.manager.enable("opencode");
    assert.equal(enabled.state, "ready");

    h.setInUse("opencode", true);
    await assert.rejects(h.manager.update("opencode"), /still in use/u);
    await assert.rejects(h.manager.remove("opencode"), /still in use/u);

    h.setInUse("opencode", false);
    const updated = await h.manager.update("opencode");
    assert.equal(updated.state, "ready");
    assert.equal(h.installs.filter((id) => id === "opencode").length, 2);
    assert.deepEqual(await h.manager.remove("opencode"), {
        id: "opencode",
        removed: true,
    });
    assert.equal(h.registry.get("opencode"), undefined);
    assert.equal(h.removes.includes("opencode"), true);
    assert.equal(await h.manager.getDefault(), undefined);
    assert.equal(await h.manager.resolveProvider(), "pi");
});

test("Provider installation failure never publishes a runtime or registry entry", async (t) => {
    const h = await harness(t);
    h.failInstall("pi");

    await assert.rejects(h.manager.install("pi"), /install failed/u);
    assert.equal(h.registry.get("pi"), undefined);
    assert.equal((await h.store.read()).providers.pi, undefined);
});

async function harness(t: test.TestContext) {
    const root = await createTestTempDirectory("agent-provider-manager");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true });
    const registryPath = join(stateDirectory, "providers.json");
    const store = new AgentProviderRegistryStore(registryPath);
    const registry = new AgentProviderRegistry();
    const installed = new Set<string>();
    const installFailures = new Set<string>();
    const inUse = new Set<string>();
    const installs: string[] = [];
    const removes: string[] = [];

    const definitions: AgentProviderDefinition[] = [
        definition("pi", "Pi", "0.1.3"),
        definition("opencode", "OpenCode", "0.1.0"),
    ];
    const manager = new AgentProviderManager({
        definitions,
        isProviderInUse: (id) => inUse.has(id),
        registry,
        runtimeRootDirectory: stateDirectory,
        store,
    });
    return {
        failInstall(id: string) {
            installFailures.add(id);
        },
        installs,
        manager,
        registry,
        registryPath,
        removes,
        setInstalled(id: string, value: boolean) {
            if (value) installed.add(id);
            else installed.delete(id);
        },
        setInUse(id: string, value: boolean) {
            if (value) inUse.add(id);
            else inUse.delete(id);
        },
        store,
    };

    function definition(
        id: string,
        name: string,
        version: string,
    ): AgentProviderDefinition {
        return {
            create: () => provider(id, version),
            id,
            async install() {
                installs.push(id);
                if (installFailures.delete(id)) {
                    throw new Error("install failed: " + id);
                }
                installed.add(id);
            },
            async isInstalled() {
                return installed.has(id);
            },
            name,
            async remove() {
                removes.push(id);
                installed.delete(id);
            },
            version,
        };
    }
}

function provider(id: string, version: string): AgentProvider {
    return {
        id,
        async start() {
            throw new Error("not started in Provider manager test");
        },
        version,
    };
}
