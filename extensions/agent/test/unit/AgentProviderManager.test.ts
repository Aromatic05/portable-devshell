import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionContext } from "@portable-devshell/extension";

import { AgentProviderRegistry } from "../../src/builtin/provider/AgentProviderRegistry.ts";

import { AgentProviderLoader } from "../../src/builtin/provider/AgentProviderLoader.ts";
import { AgentProviderManager } from "../../src/builtin/provider/AgentProviderManager.ts";
import { AgentProviderRegistryStore } from "../../src/builtin/provider/AgentProviderRegistryStore.ts";
import { AgentExtensionRuntime } from "../../src/builtin/AgentRuntime.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

async function harness(t: test.TestContext) {
    const root = await createTestTempDirectory("agent-provider-manager");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const dataDirectory = join(root, "data");
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true });
    const generations = new Map<string, string>();
    const removed: string[] = [];
    const assets = {
        async installBundle(sourcePath: string) {
            const generation = generations.get(sourcePath);
            if (generation === undefined) throw new Error(`Unknown fixture bundle: ${sourcePath}`);
            return { directory: join(dataDirectory, "bundles", generation), generation };
        },
        async installDirectory() { throw new Error("not used"); },
        async listBundles() {
            return [...new Set(generations.values())].map((generation) => ({
                directory: join(dataDirectory, "bundles", generation),
                generation
            }));
        },
        async removeBundle(generation: string) {
            removed.push(generation);
        },
        async resolveBundle(generation: string) {
            return { directory: join(dataDirectory, "bundles", generation), generation };
        },
        async projectBundle() { throw new Error("not used"); }
    };
    const context: ExtensionContext = {
        capabilities: {
            assets,
            processes: {
                async start() { throw new Error("not used"); }
            },
            delegatedWorkers: {
                async openSession(input) {
                    let resolveClosed!: () => void;
                    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
                    let isClosed = false;
                    return {
                        closed,
                        environment: {
                            homeDirectory: "/home/dev",
                            platform: { arch: "x64", os: "linux" },
                        },
                        instance: input.instance ?? "worker-a",
                        workspace: input.workspace,
                        async callTool() { return {}; },
                        async close() {
                            if (isClosed) return;
                            isClosed = true;
                            resolveClosed();
                        },
                        listTools() { return []; }
                    };
                }
            }
        },
        generation: "agent-generation",
        id: "agent",
        logger: { debug() {}, error() {}, info() {}, warn() {} },
        paths: {
            codeDirectory: join(root, "code"),
            dataDirectory,
            runtimeDirectory: join(root, "runtime"),
            stateDirectory
        },
        register() {},
        version: "0.1.0"
    };
    const store = new AgentProviderRegistryStore(join(stateDirectory, "providers.json"));
    const loader = new AgentProviderLoader(context, undefined, store);
    const registry = new AgentProviderRegistry();
    let inUse = false;
    const manager = new AgentProviderManager({
        bundledProviders: { pi: "/bundled/pi.dsprovider" },
        context,
        isProviderInUse: () => inUse,
        loader,
        registry,
        store
    });
    return {
        context,
        generations,
        manager,
        registry,
        removed,
        setInUse(value: boolean) { inUse = value; },
        store
    };
}

async function writeProvider(
    context: ExtensionContext,
    generation: string,
    version: string,
    options: { id?: string; runtimeId?: string } = {}
): Promise<void> {
    const id = options.id ?? "pi";
    const directory = join(context.paths.dataDirectory, "bundles", generation);
    await mkdir(join(directory, "dist"), { recursive: true });
    await writeFile(join(directory, "devshell-agent-provider.json"), `${JSON.stringify({
        apiVersion: 1,
        entry: "dist/index.mjs",
        id,
        name: id,
        schemaVersion: 1,
        version
    })}\n`, "utf8");
    await writeFile(join(directory, "dist", "index.mjs"), [
        "export function createAgentProvider() {",
        "  const closed = new Promise(() => {});",
        `  return { id: ${JSON.stringify(options.runtimeId ?? id)}, version: ${JSON.stringify(version)},`,
        "    async start() {",
        "      return { closed, async prompt() {}, async stop() {} };",
        "    }",
        "  };",
        "}",
        ""
    ].join("\n"), "utf8");
}

test("Agent provider install atomically selects a validated generation and hot-replaces future starts", async (t) => {
    const h = await harness(t);
    await writeProvider(h.context, "provider-v1", "0.1.0");
    await writeProvider(h.context, "provider-v2", "0.2.0");
    h.generations.set("/bundle-v1", "provider-v1");
    h.generations.set("/bundle-v2", "provider-v2");

    const first = await h.manager.install("/bundle-v1");
    assert.equal(first.version, "0.1.0");
    assert.equal(h.registry.require("pi").version, "0.1.0");

    const second = await h.manager.install("/bundle-v2");
    assert.equal(second.version, "0.2.0");
    assert.equal(h.registry.require("pi").version, "0.2.0");
    const snapshot = await h.store.read();
    assert.equal(snapshot.providers.pi?.selectedGeneration, "provider-v2");
    assert.equal(snapshot.providers.pi?.lastKnownGoodGeneration, "provider-v2");
});

test("bundled Pi ensure-install upgrades an older generation but never downgrades a newer selected generation", async (t) => {
    const h = await harness(t);
    await writeProvider(h.context, "provider-v1", "0.1.0");
    h.generations.set("/bundled/pi.dsprovider", "provider-v1");

    const first = await h.manager.installBundled("pi");
    assert.equal(first.version, "0.1.0");
    assert.equal((await h.store.read()).defaultProvider, "pi");

    await writeProvider(h.context, "provider-v2", "0.2.0");
    h.generations.set("/bundled/pi.dsprovider", "provider-v2");
    const second = await h.manager.installBundled("pi");
    assert.equal(second.version, "0.2.0");
    assert.equal((await h.store.read()).providers.pi?.selectedGeneration, "provider-v2");
    assert.equal((await h.store.read()).defaultProvider, "pi");
    assert.equal(h.registry.require("pi").version, "0.2.0");

    await writeProvider(h.context, "provider-v3", "0.3.0");
    h.generations.set("/provider-v3.dsprovider", "provider-v3");
    await h.manager.install("/provider-v3.dsprovider");
    h.generations.set("/bundled/pi.dsprovider", "provider-v2");
    const preserved = await h.manager.installBundled("pi");
    assert.equal(preserved.version, "0.3.0");
    assert.equal((await h.store.read()).providers.pi?.selectedGeneration, "provider-v3");
    assert.equal(h.registry.require("pi").version, "0.3.0");
    assert.equal(h.removed.includes("provider-v2"), true);
});

test("bundled provider migration preserves a disabled provider while updating its generation floor", async (t) => {
    const h = await harness(t);
    await writeProvider(h.context, "provider-v1", "0.1.1");
    await writeProvider(h.context, "provider-v2", "0.1.2");
    h.generations.set("/bundle-v1", "provider-v1");
    h.generations.set("/bundled/pi.dsprovider", "provider-v2");
    await h.manager.install("/bundle-v1");
    await h.manager.disable("pi");

    const migrated = await h.manager.installBundled("pi");

    assert.equal(migrated.version, "0.1.2");
    assert.equal(migrated.enabled, false);
    assert.equal(migrated.state, "disabled");
    assert.equal((await h.store.read()).providers.pi?.selectedGeneration, "provider-v2");
    assert.equal(h.registry.get("pi"), undefined);
});

test("Agent provider default selection is explicit and remains provider-neutral", async (t) => {
    const h = await harness(t);
    await writeProvider(h.context, "pi-v1", "0.1.0");
    await writeProvider(h.context, "opencode-v1", "1.0.0", { id: "opencode" });
    h.generations.set("/pi", "pi-v1");
    h.generations.set("/opencode", "opencode-v1");

    await h.manager.install("/pi");
    await h.manager.install("/opencode");
    assert.equal(await h.manager.resolveProvider(), "pi");
    assert.equal(await h.manager.resolveProvider("opencode"), "opencode");

    assert.equal(await h.manager.setDefault("opencode"), "opencode");
    assert.equal(await h.manager.getDefault(), "opencode");
    assert.equal(await h.manager.resolveProvider(), "opencode");

    await h.manager.remove("opencode");
    assert.equal(await h.manager.getDefault(), undefined);
    assert.equal(await h.manager.resolveProvider(), "pi");
});

test("Agent provider manager serializes concurrent mutations", async (t) => {
    const h = await harness(t);
    await writeProvider(h.context, "provider-v1", "0.1.0");
    await writeProvider(h.context, "provider-v2", "0.2.0");
    h.generations.set("/bundle-v1", "provider-v1");
    h.generations.set("/bundle-v2", "provider-v2");
    const assets = h.context.capabilities.assets!;
    const originalInstall = assets.installBundle.bind(assets);
    let activeInstalls = 0;
    let maxActiveInstalls = 0;
    assets.installBundle = async (sourcePath) => {
        activeInstalls += 1;
        maxActiveInstalls = Math.max(maxActiveInstalls, activeInstalls);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        try {
            return await originalInstall(sourcePath);
        } finally {
            activeInstalls -= 1;
        }
    };

    await Promise.all([
        h.manager.install("/bundle-v1"),
        h.manager.install("/bundle-v2")
    ]);

    assert.equal(maxActiveInstalls, 1);
    assert.equal((await h.store.read()).providers.pi?.selectedGeneration, "provider-v2");
    assert.equal(h.registry.require("pi").version, "0.2.0");
});

test("Agent provider hot replacement preserves running handles and affects only future Agent starts", async (t) => {
    const h = await harness(t);
    await writeProvider(h.context, "provider-v1", "0.1.0");
    await writeProvider(h.context, "provider-v2", "0.2.0");
    h.generations.set("/bundle-v1", "provider-v1");
    h.generations.set("/bundle-v2", "provider-v2");
    await h.manager.install("/bundle-v1");
    const runtime = new AgentExtensionRuntime(h.context, { registry: h.registry });

    const first = await runtime.start({ provider: "pi", target: "worker-a:/one" });
    await h.manager.install("/bundle-v2");
    const second = await runtime.start({ provider: "pi", target: "worker-a:/two" });

    assert.equal(first.providerVersion, "0.1.0");
    assert.equal(second.providerVersion, "0.2.0");
    assert.equal(runtime.get(first.agentId)?.providerVersion, "0.1.0");
    assert.equal(runtime.get(second.agentId)?.providerVersion, "0.2.0");
    await runtime.stop({ agentId: first.agentId });
    await runtime.stop({ agentId: second.agentId });
});

test("Agent provider candidate failure preserves the previous selected generation and runtime provider", async (t) => {
    const h = await harness(t);
    await writeProvider(h.context, "provider-good", "0.1.0");
    await writeProvider(h.context, "provider-bad", "0.2.0", { runtimeId: "other" });
    h.generations.set("/good", "provider-good");
    h.generations.set("/bad", "provider-bad");
    await h.manager.install("/good");

    await assert.rejects(h.manager.install("/bad"), /returned id other/u);

    assert.equal(h.registry.require("pi").version, "0.1.0");
    const snapshot = await h.store.read();
    assert.equal(snapshot.providers.pi?.selectedGeneration, "provider-good");
    assert.deepEqual(h.removed, ["provider-bad"]);
});

test("Agent provider disable and enable affect future starts while remove refuses an in-use provider", async (t) => {
    const h = await harness(t);
    await writeProvider(h.context, "provider-v1", "0.1.0");
    h.generations.set("/bundle", "provider-v1");
    await h.manager.install("/bundle");

    const disabled = await h.manager.disable("pi");
    assert.equal(disabled.enabled, false);
    assert.equal(h.registry.get("pi"), undefined);

    const enabled = await h.manager.enable("pi");
    assert.equal(enabled.enabled, true);
    assert.equal(h.registry.require("pi").version, "0.1.0");

    h.setInUse(true);
    await assert.rejects(h.manager.remove("pi"), /still in use/u);
    assert.notEqual(h.registry.get("pi"), undefined);

    h.setInUse(false);
    assert.deepEqual(await h.manager.remove("pi"), { id: "pi", removed: true });
    assert.equal(h.registry.get("pi"), undefined);
    assert.deepEqual(h.removed, ["provider-v1"]);
    assert.equal((await h.store.read()).providers.pi, undefined);
});
