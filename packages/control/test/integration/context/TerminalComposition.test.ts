import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { asInstanceName, ControlPathHome, Endpoint, Rpc, createDefaultControlConfig } from "@portable-devshell/shared";
import { EXTENSION_API_VERSION, EXTENSION_MANIFEST_SCHEMA_VERSION, type ExtensionManifest } from "@portable-devshell/extension";
import { ControlFactory } from "../../../src/Factory.ts";
import { ControlConfig } from "../../../src/config/index.ts";
import { ControlInstances } from "../../../src/instance/index.ts";
import { ExtensionLoader } from "../../../src/extension/discovery/Loader.ts";
import { ExtensionGeneration } from "../../../src/extension/registration/Generation.ts";
import { ExtensionRegistrationSet } from "../../../src/extension/registration/Registration.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => { resolve = yes; });
    return { promise, resolve };
}

for (const reason of ["disabled", "expired"] as const) {
    test(`Factory Context ${reason} notifies each attachment once and pins both through reload`, { timeout: 10000 }, async (t) => {
        let clock = Date.now();
        t.mock.method(Date, "now", () => clock);
        const home = await createTestTempDirectory(`context-terminal-${reason}`);
        const paths = new ControlPathHome(home);
        const registryFile = join(paths.controlHomeDir, "extensions", "registry.json");
        await mkdir(dirname(registryFile), { recursive: true });
        const hash = "a".repeat(64);
        await writeFile(registryFile, JSON.stringify({ schemaVersion: 1, extensions: { terminal: { enabled: true, selectedGeneration: hash } } }));
        const manifest: ExtensionManifest = {
            activation: "eager", apiVersion: EXTENSION_API_VERSION, schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
            capabilities: [], entry: "extension.mjs", hostDependencies: {}, id: "terminal", name: "Terminal", version: "1.0.0", extensions: {},
        };
        const events: Array<{ runtime: number; ctxId: string; instance: string; reason: string }> = [];
        const runtimes: ExtensionGeneration[] = [];
        const disposed: number[] = [];
        const entered = deferred();
        const finish = deferred();
        t.mock.method(ExtensionLoader.prototype, "readManifest", async () => manifest);
        t.mock.method(ExtensionLoader.prototype, "load", async () => {
            const number = runtimes.length + 1;
            const generation = new ExtensionGeneration({ generation: hash, manifest,
                registrations: new ExtensionRegistrationSet([]),
                dispose: async () => { disposed.push(number); },
                contextEnvironmentRetired: async (event) => {
                    events.push({ runtime: number, ...event });
                    if (events.length === 2) entered.resolve();
                    await finish.promise;
                },
            });
            runtimes.push(generation);
            return generation;
        });
        // Real instance RPC cleanup, served locally so no worker process or service is needed.
        const workers = new Map(["alpha", "beta"].map((name) => [name, new Endpoint({ host: asInstanceName(name) })]));
        const releases: string[] = [];
        for (const [name, worker] of workers) {
            new Rpc(worker.bind("instance"), { releaseReference: async () => { releases.push(name); return undefined; } });
        }
        t.mock.method(Endpoint.prototype, "connect", async (host: Parameters<Endpoint["connect"]>[0], port: Parameters<Endpoint["connect"]>[1]) => {
            const worker = workers.get(host);
            assert.ok(worker, `unexpected worker ${host}`);
            return worker.bind("test-client").connect(host, port);
        });
        const config = new ControlConfig();
        const document = createDefaultControlConfig();
        document.mcp.enabled = false;
        document.web.enabled = false;
        config.set(document);
        const instances = new ControlInstances();
        const { state } = await new ControlFactory({ builtinExtensionSources: [] }).create({
            config, instances, homeDirectory: home, socketPath: join(home, "control.sock"), restart: async () => {}, shutdown: async () => {},
        });
        t.after(async () => {
            finish.resolve();
            await state.close();
            await instances.close();
            for (const worker of workers.values()) worker.close();
            await rm(home, { recursive: true, force: true });
        });
        await state.initialize();
        await state.start();
        assert.equal(runtimes.length, 1);
        const record = await state.contexts.api.registry.create({ principal: "test", environments: [{ instance: "alpha" }, { instance: "beta" }] });
        await state.contexts.api.renew(record.ctxId);
        await state.reconcile();
        assert.deepEqual(events, []);
        if (reason === "expired") {
            // Advance the clock without replacing Context or its registry.
            clock = Date.parse(record.expiresAt) + 1;
        }
        const pending = reason === "disabled" ? state.contexts.api.disable(record.ctxId) : state.reconcile();
        await entered.promise;
        await state.extensions.control.reload("terminal");
        assert.equal(runtimes[0]!.state, "draining");
        assert.equal(runtimes[0]!.inFlight, 2);
        assert.deepEqual(disposed, []);
        finish.resolve();
        await pending;
        await state.contexts.api.cleanup.reconcile(record.ctxId);
        if (reason === "disabled") await state.contexts.api.disable(record.ctxId);
        assert.deepEqual(events, ["alpha", "beta"].map((instance) => ({ runtime: 1, ctxId: record.ctxId, instance, reason })));
        assert.deepEqual(releases.sort(), ["alpha", "beta"]);
        assert.equal(JSON.parse(await readFile(paths.contextsFile, "utf8")).contexts[0].cleanupPending, false);
        assert.deepEqual(disposed, [1]);
    });
}

test("Factory retains terminal notification debt before Extension startup and after startup failure", async (t) => {
    const home = await createTestTempDirectory("context-terminal-unavailable");
    const config = new ControlConfig();
    const document = createDefaultControlConfig();
    document.mcp.enabled = false;
    document.web.enabled = false;
    config.set(document);
    const instances = new ControlInstances();
    const { state } = await new ControlFactory({ builtinExtensionSources: [] }).create({
        config, instances, homeDirectory: home, socketPath: join(home, "control.sock"), restart: async () => {}, shutdown: async () => {},
    });
    t.after(async () => { await state.close(); await instances.close(); await rm(home, { recursive: true, force: true }); });
    t.mock.method(Endpoint.prototype, "connect", async () => { throw new Error("worker unavailable"); });
    t.mock.method(console, "warn", () => {});
    const notified = t.mock.method(state.extensions, "contextEnvironmentRetired", async () => {});
    await state.initialize();
    const record = await state.contexts.api.registry.create({ principal: "test", environments: [{ instance: "alpha" }] });
    await assert.rejects(state.contexts.api.disable(record.ctxId), /cleanup was incomplete/u);
    assert.equal(notified.mock.callCount(), 0);
    assert.equal((await state.contexts.api.registry.listCleanupPending()).length, 1);
    t.mock.method(state.extensions, "start", async () => { throw new Error("Extension registry unavailable"); });
    await state.start();
    await assert.rejects(state.contexts.api.cleanup.reconcile(record.ctxId), /cleanup was incomplete/u);
    assert.equal(notified.mock.callCount(), 0);
    assert.equal((await state.contexts.api.registry.listCleanupPending()).length, 1);
    assert.deepEqual(await state.contexts.api.registry.listRetiredEnvironmentInstances(record.ctxId), []);
});
