import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { createDefaultControlConfig, normalizeConfigInstanceDraft, toConfigInstanceDraft } from "@portable-devshell/shared";
import { ConfigEngine } from "../../../../src/config/engine/index.ts";
import { ControlConfigStore } from "../../../../src/config/store/index.ts";
import { InstanceRegistry } from "../../../../src/instance/Registry.ts";
import { InstanceChangeHub } from "../../../../src/instance/Change.ts";
import { InstanceEditorCoordinator } from "../../../../src/instance/editor/index.ts";
import { InstanceCreateCoordinator } from "../../../../src/instance/editor/create/index.ts";
import { createTestInstance } from "../../../support/InstanceRuntime.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { assertInstanceDeletable } from "../../../../src/instance/editor/retirement/Runtime.ts";
import { createContextRuntime } from "../../../../src/context/index.ts";

async function fixture(t: test.TestContext, options: { ready?: boolean; alerts?: boolean; restart?: boolean } = {}) {
    const home = await createTestTempDirectory("retirement-recovery");
    t.after(() => rm(home, { recursive: true, force: true }));
    const events: string[] = [];
    let ready = options.ready === true;
    let allowAlerts = !options.alerts;
    const config = createDefaultControlConfig();
    config.mcp.enabled = true;
    const instance = normalizeConfigInstanceDraft({ name: "retire-reverse", provider: "reverse", mcp: { enabled: false } });
    config.instances = options.restart ? [] : [instance];
    const store = new ControlConfigStore();
    await store.write(config, home);
    const engine = new ConfigEngine({ configStore: store, homeDirectory: home,
        getConfig: () => config, setConfig: (next) => Object.assign(config, next) });
    const descriptors: ReturnType<typeof createTestInstance>[] = [];
    const createRuntimeInstance = (draft: typeof instance) => {
        const descriptor = createTestInstance(draft, {
            managementMode: "selfManaged",
            snapshot: () => ({ ready, daemonState: ready ? "running" : "stopped" }),
            start: async () => { events.push("start"); throw new Error("illegal Reverse start"); },
            stop: async () => { events.push("stop"); throw new Error("illegal Reverse stop"); },
            releaseReference: async () => { events.push("reference"); },
            releaseAlerts: async () => {
                events.push("alerts");
                assert.equal(ready, true, "remote Worker offline");
                assert.equal(allowAlerts, true, "remote release temporarily unavailable");
            },
            retireRuntime: async () => { events.push("runtime"); throw new Error("illegal Reverse retirement"); },
        });
        descriptors.push(descriptor);
        return descriptor;
    };
    const instanceRegistry = new InstanceRegistry(config.instances.map(createRuntimeInstance));
    const file = join(home, "cleanup.json");
    if (options.restart) await writeFile(file, JSON.stringify([{
        generationId: "old-generation", operation: "delete", instance: toConfigInstanceDraft(instance),
    }]));
    const contexts = createContextRuntime({
        contextFile: join(home, "contexts.json"), environment: () => ({}) as never,
        process: () => ({}) as never, runtime: () => ({}) as never,
        leaseInstance: () => ({ release() {} }),
    });
    await contexts.initialize();
    const context = await contexts.api.registry.create({ principal: "local" });
    await contexts.api.registry.attachEnvironment(context.ctxId, {
        instance: instance.name, ...(options.alerts ? { workspace: "/old-workspace" } : {}),
    });
    const shared = { engine, instanceRegistry, instanceChanges: new InstanceChangeHub(),
        createRuntimeInstance, finalizeRuntimeInstance: async (descriptor: ReturnType<typeof createTestInstance>) => descriptor.close() };
    const editorOptions: ConstructorParameters<typeof InstanceEditorCoordinator>[0] = { ...shared, cleanupDebtFile: file,
        detachContextInstance: (name) => contexts.api.detachInstance(name).then(() => undefined),
        reconcileContextInstanceCleanup: (name, target) => contexts.api.cleanup.reconcileInstance(name, target),
    };
    const editor = new InstanceEditorCoordinator(editorOptions);
    const creator = new InstanceCreateCoordinator({ ...shared,
        assertCleanupSettled: (name, reconcile) => editor.assertInstanceCleanupSettled(name, reconcile) });
    t.after(async () => { for (const descriptor of descriptors) await descriptor.close(); });
    t.mock.method(console, "warn", () => {});
    return { editor, creator, instance, instanceRegistry, engine, file, events, contexts,
        setReady: () => { ready = true; allowAlerts = true; },
        restartEditor: () => new InstanceEditorCoordinator(editorOptions) };
}

for (const restart of [false, true]) {
    test(`stopped Reverse releases Control references without lifecycle commands (restart=${restart})`, async (t) => {
        const f = await fixture(t, { restart });
        await (restart
            ? f.editor.reconcileCleanupDebt(f.instance.name)
            : f.editor.deleteInstance({ instanceName: f.instance.name }));
        await f.editor.reconcileCleanupDebt(f.instance.name);
        assert.deepEqual(await f.editor.listCleanupDebts(), []);
        assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), []);
        assert.deepEqual(f.events, ["reference"]);
        await f.creator.createInstance({ name: f.instance.name, provider: "reverse", mcp: { enabled: false } });
        assert.ok(f.instanceRegistry.get(f.instance.name));
        assert.deepEqual(f.events, ["reference"]);
    });
}

test("unresolved Reverse alert cleanup preserves its generation and recovers using the same connection", async (t) => {
    const f = await fixture(t, { restart: true, alerts: true, ready: true });
    await f.editor.reconcileCleanupDebt(f.instance.name);
    const [debt] = await f.editor.listCleanupDebts();
    assert.equal(debt!.generationId, "old-generation");
    assert.equal(debt!.state, "pending");
    assert.match(debt!.reason!, /remote release temporarily unavailable/);
    assert.equal((await f.contexts.api.registry.listEnvironmentCleanup()).length, 1);
    assert.equal(f.events.includes("start"), false);
    assert.equal(f.events.includes("stop"), false);
    await assert.rejects(f.editor.assertInstanceCleanupSettled(f.instance.name, false), { code: "instance.conflict" });
    f.setReady();
    await f.editor.reconcileCleanupDebt(f.instance.name);
    assert.deepEqual(await f.editor.listCleanupDebts(), []);
    assert.equal(f.events.includes("runtime"), false);
    assert.equal(f.events.includes("start"), false);
    assert.equal(f.events.includes("stop"), false);
});

test("offline Reverse alert scopes remain durable orphans and never replay against same-name recreation", async (t) => {
    const f = await fixture(t, { alerts: true });
    const result = await f.editor.deleteInstance({ instanceName: f.instance.name }) as Record<string, unknown>;
    assert.equal(result.cleanupPending, false);
    const [debt] = await f.editor.listCleanupDebts();
    assert.equal(debt!.state, "orphaned");
    assert.equal(debt!.abandonedContextAlertCount, "1");
    const [persisted] = JSON.parse(await readFile(f.file, "utf8"));
    assert.deepEqual(persisted.abandonedContextAlerts, ["/old-workspace"]);
    assert.equal(persisted.generationId, debt!.generationId);
    assert.deepEqual(await f.contexts.api.registry.listEnvironmentCleanup(), []);
    await f.creator.createInstance({ name: f.instance.name, provider: "reverse", mcp: { enabled: false } });
    f.setReady();
    const restarted = f.restartEditor();
    await restarted.reconcileCleanupDebt(f.instance.name);
    assert.deepEqual(f.events, ["reference"]);
    assert.equal((await restarted.listCleanupDebts())[0]!.generationId, debt!.generationId);
    assert.equal((await restarted.listCleanupDebts())[0]!.state, "orphaned");
});

test("Context ledger failure after orphan persistence retries the handoff without remote replay", async (t) => {
    const f = await fixture(t, { restart: true, alerts: true });
    const registry = f.contexts.api.registry;
    const settle = registry.settleEnvironmentCleanup.bind(registry);
    const failedWrite = t.mock.method(registry, "settleEnvironmentCleanup", async (
        ctxId: string, cleanup: Parameters<typeof registry.settleEnvironmentCleanup>[1],
    ) => {
        if (cleanup.kind === "alerts") throw new Error("Context ledger write unavailable");
        await settle(ctxId, cleanup);
    });
    await f.editor.reconcileCleanupDebt(f.instance.name);
    assert.equal((await f.editor.listCleanupDebts())[0]!.state, "pending");
    assert.equal((await f.contexts.api.registry.listEnvironmentCleanup()).length, 1);
    assert.deepEqual(JSON.parse(await readFile(f.file, "utf8"))[0].abandonedContextAlerts, ["/old-workspace"]);
    failedWrite.mock.restore();
    f.setReady();
    const restarted = f.restartEditor();
    await restarted.reconcileCleanupDebt(f.instance.name);
    assert.deepEqual(await f.contexts.api.registry.listEnvironmentCleanup(), []);
    assert.equal((await restarted.listCleanupDebts())[0]!.state, "orphaned");
    assert.deepEqual(f.events, ["reference"]);
});

test("failed durable orphan write keeps the Context alert obligation pending", async (t) => {
    const f = await fixture(t, { restart: true, alerts: true });
    // Load the old debt before making its destination unwritable by rename.
    const [before] = await f.editor.listCleanupDebts();
    const original = await readFile(f.file, "utf8");
    await rm(f.file);
    await mkdir(f.file);
    await f.editor.reconcileCleanupDebt(f.instance.name);
    assert.equal((await f.contexts.api.registry.listEnvironmentCleanup()).length, 1);
    assert.equal((await f.editor.listCleanupDebts())[0]!.state, "pending");
    assert.equal((await f.editor.listCleanupDebts())[0]!.generationId, before!.generationId);
    await rm(f.file, { recursive: true });
    await writeFile(f.file, original);
    await f.editor.reconcileCleanupDebt(f.instance.name);
    assert.deepEqual(await f.contexts.api.registry.listEnvironmentCleanup(), []);
    assert.equal((await f.editor.listCleanupDebts())[0]!.state, "orphaned");
    assert.deepEqual(f.events, ["reference"]);
});

test("orphan rename followed by failed directory sync cannot replay on a recovered connection", async (t) => {
    const f = await fixture(t, { restart: true, alerts: true });
    const open = fs.open;
    let failures = 0;
    const injected = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (String(args[0]) === dirname(f.file) && failures === 0 &&
            (await readFile(f.file, "utf8")).includes('"abandonedContextAlerts"')) {
            t.mock.method(handle, "sync", async () => {
                failures++;
                throw new Error("debt directory sync acknowledgement lost");
            });
        }
        return handle;
    });
    syncBuiltinESMExports();
    t.after(() => { injected.mock.restore(); syncBuiltinESMExports(); });
    await f.editor.reconcileCleanupDebt(f.instance.name);
    assert.equal(failures, 1);
    assert.equal((await f.contexts.api.registry.listEnvironmentCleanup()).length, 1);
    assert.equal((await f.editor.listCleanupDebts())[0]!.state, "pending");
    f.setReady();
    await f.editor.reconcileCleanupDebt(f.instance.name);
    assert.deepEqual(f.events, ["reference"]);
    assert.deepEqual(await f.contexts.api.registry.listEnvironmentCleanup(), []);
    assert.equal((await f.editor.listCleanupDebts())[0]!.state, "orphaned");
});

test("old deletion debt cannot clean up a configured replacement generation", async (t) => {
    const f = await fixture(t, { restart: true });
    const replacement = normalizeConfigInstanceDraft({ ...toConfigInstanceDraft(f.instance), provider: "local" });
    await f.engine.persist({ ...f.engine.current, instances: [replacement] });
    await f.editor.reconcileCleanupDebt(f.instance.name);
    assert.deepEqual(f.events, []);
    assert.equal((await f.editor.listCleanupDebts())[0]!.generationId, "old-generation");
    assert.equal(f.engine.current.instances[0]!.provider, "local");
});

test("local failed/stale snapshots cannot skip native cleanup; self-managed snapshots always do", () => {
    for (const daemonState of ["stopped", "stale", "failed", "unknown", "running"]) {
        const config = normalizeConfigInstanceDraft({ name: "retire-local", provider: "local" });
        const local = createTestInstance(config, { snapshot: () => ({ daemonState }) });
        const reverse = createTestInstance(config, { managementMode: "selfManaged", snapshot: () => ({ daemonState }) });
        assert.equal(assertInstanceDeletable(config.name, local), false);
        assert.equal(assertInstanceDeletable(config.name, reverse), true);
    }
});
