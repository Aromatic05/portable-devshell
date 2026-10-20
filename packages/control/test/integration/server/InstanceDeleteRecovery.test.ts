import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";

import {
    Endpoint,
    LocalChannel,
    ControlPathHome,
    createInstanceTransport,
    createProcessTransport,
    createServerTransport,
    normalizeConfigInstanceDraft,
    toConfigInstanceDraft,
    createDefaultControlConfig,
    type ControlConfig,
} from "@portable-devshell/shared";

import { Control } from "../../../src/Control.ts";
import { ControlFactory } from "../../../src/Factory.ts";
import { ControlConfigStore } from "../../../src/config/store/index.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { resolveTestWorkerBinary } from "../../../../../test/TestPlatformSupport.ts";
import { ConfigEngine } from "../../../src/config/engine/index.ts";
import { InstanceChangeHub } from "../../../src/instance/Change.ts";
import { InstanceRegistry } from "../../../src/instance/Registry.ts";
import { InstanceEditorCoordinator } from "../../../src/instance/editor/index.ts";
import { InstanceCreateCoordinator } from "../../../src/instance/editor/create/index.ts";
import { createTestInstance } from "../../support/InstanceRuntime.ts";

test("deletion removes unreachable providers and permits same-name recreation", async (t) => {
    // The Linux release resolver intentionally does not pick up a native
    // target/debug binary. Tell the integration fixture which Worker was
    // prepared by test:prepare instead of relying on an old musl build.
    const preparedWorker = resolveTestWorkerBinary();
    if (process.env.CI && preparedWorker === undefined)
        throw new Error("Instance delete integration requires the prepared Worker.");
    if (preparedWorker !== undefined &&
        process.platform === "linux" &&
        (process.arch === "x64" || process.arch === "arm64")) {
        const key = "PORTABLE_DEVSHELL_WORKER_LINUX_" +
            (process.arch === "x64" ? "X64" : "ARM64") + "_PATH";
        const previous = process.env[key];
        process.env[key] = preparedWorker;
        t.after(() => {
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
        });
    }
    const home = await createTestTempDirectory(
        "control-instance-delete-recovery",
    );
    const store = new ControlConfigStore();
    const config = await store.readOrCreate(home);
    config.mcp.enabled = true;
    config.mcp.listenHost = "127.0.0.1";
    config.mcp.listenPort = 0;
    config.mcp.publicBaseUrl = "http://127.0.0.1:17890";
    await store.write(config, home);

    const control = new Control({
        configStore: store,
        factory: new ControlFactory({ builtinExtensionSources: [] }),
        homeDirectory: home,
        xdgRuntimeDir: home,
    });
    const endpoint = new Endpoint({
        connectChannel: (signal) =>
            LocalChannel.connect(control.socketPath, { signal }),
    });
    const warnings: string[] = [];
    const previousWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    t.after(async () => {
        console.warn = previousWarn;
        endpoint.close();
        await control.stop().catch(() => undefined);
        await rm(home, { force: true, recursive: true });
    });
    await control.start();
    await createServerTransport(endpoint, { clientKind: "cli" }).hello();
    const instances = createInstanceTransport(endpoint);

    const drafts = [
        { name: "delete-local", provider: "local", mcp: { enabled: false } },
        {
            name: "delete-ssh",
            provider: "ssh",
            enabled: false,
            ssh: { command: "ssh testspace.invalid" },
            mcp: { enabled: false },
        },
        {
            name: "delete-docker",
            provider: "docker",
            enabled: false,
            dockerBinary: "missing-test-docker",
            container: { mode: "existingImage", image: "alpine:latest" },
            mcp: { enabled: false },
        },
        {
            name: "delete-podman",
            provider: "podman",
            enabled: false,
            podmanBinary: "missing-test-podman",
            container: { mode: "existingImage", image: "alpine:latest" },
            mcp: { enabled: false },
        },
        { name: "delete-reverse", provider: "reverse", mcp: { enabled: true } },
    ] as const;

    for (const draft of drafts) {
        await instances.createInstance(draft);
        if (draft.provider === "reverse") {
            const snapshot = (
                await createProcessTransport(endpoint, draft.name).refresh()
            ).snapshot;
            assert.equal(snapshot.daemonState, "unknown");
            assert.equal(snapshot.status, "offline");
        }
        const deleted = await instances.deleteInstance(draft.name);
        assert.equal(
            deleted.cleanupPending,
            false,
            draft.provider + ": " + JSON.stringify(deleted.cleanupWarnings ?? []),
        );
        assert.equal(
            (await instances.listInstances()).some(
                (entry) => entry.name === draft.name,
            ),
            false,
            draft.provider,
        );
        await instances.createInstance(draft);
        const deletedAgain = await instances.deleteInstance(draft.name);
        assert.equal(
            deletedAgain.cleanupPending,
            false,
            draft.provider + ": " + JSON.stringify(deletedAgain.cleanupWarnings ?? []),
        );
    }

    assert.ok(
        warnings.some((warning) =>
            warning.includes("remote retirement incomplete"),
        ),
    );
    assert.deepEqual(
        (await instances.listInstances()).map((entry) => entry.name),
        [],
    );
});

test("historical unreachable-provider cleanup debts no longer block same-name reuse", async (t) => {
    const home = await createTestTempDirectory("control-old-instance-cleanup");
    const store = new ControlConfigStore();
    const config = await store.readOrCreate(home);
    config.mcp.enabled = true;
    config.mcp.listenHost = "127.0.0.1";
    config.mcp.listenPort = 0;
    config.mcp.publicBaseUrl = "http://127.0.0.1:17890";
    await store.write(config, home);
    const drafts = [
        {
            name: "old-delete-ssh",
            provider: "ssh",
            enabled: false,
            ssh: { command: "ssh testspace.invalid" },
        },
        {
            name: "old-delete-podman",
            provider: "podman",
            enabled: false,
            podmanBinary: "missing-test-podman",
            container: { mode: "existingImage", image: "alpine:latest" },
        },
        {
            name: "old-delete-reverse",
            provider: "reverse",
            enabled: true,
            mcp: { enabled: true },
        },
    ] as const;
    const cleanupFile = new ControlPathHome(home).lifecycleCleanupFile;
    await mkdir(dirname(cleanupFile), { recursive: true });
    await writeFile(
        cleanupFile,
        JSON.stringify(
            drafts.map((draft) => ({
                instance: toConfigInstanceDraft(
                    normalizeConfigInstanceDraft(draft),
                ),
                operation: "delete",
            })),
        ),
    );

    const control = new Control({
        configStore: store,
        factory: new ControlFactory({ builtinExtensionSources: [] }),
        homeDirectory: home,
        xdgRuntimeDir: home,
    });
    const endpoint = new Endpoint({
        connectChannel: (signal) =>
            LocalChannel.connect(control.socketPath, { signal }),
    });
    const previousWarn = console.warn;
    console.warn = () => undefined;
    t.after(async () => {
        console.warn = previousWarn;
        endpoint.close();
        await control.stop().catch(() => undefined);
        await rm(home, { force: true, recursive: true });
    });

    await control.start();
    await createServerTransport(endpoint, { clientKind: "cli" }).hello();
    const instances = createInstanceTransport(endpoint);
    for (const draft of drafts) {
        await instances.createInstance(draft);
        const result = await instances.deleteInstance(draft.name);
        assert.equal(result.cleanupPending, false, draft.name);
    }
    const retained = JSON.parse(await readFile(cleanupFile, "utf8")) as Array<{
        generationId?: string;
        orphaned?: boolean;
        instance: { name: string };
    }>;
    assert.ok(retained.every((record) => record.orphaned === true));
    assert.equal(new Set(retained.map((record) => record.generationId)).size, retained.length);
    assert.ok(retained.every((record) => drafts.some((draft) => draft.name === record.instance.name)));
});

test("same-name creation waits for old provider cleanup and recovery cannot erase replacement resources", { timeout: 10_000 }, async (t) => {
    const home = await createTestTempDirectory("instance-generation-cleanup-race");
    const resource = join(home, "provider-resource");
    const cleanupEntered = cleanupGate();
    const releaseCleanup = cleanupGate();
    const creationEntered = cleanupGate();
    const draft = { name: "generation-local", provider: "local", mcp: { enabled: false } } as const;
    let config = createDefaultControlConfig();
    config.instances = [normalizeConfigInstanceDraft(draft)];
    await writeFile(resource, "old generation");
    let providerRetirements = 0;
    const original = createTestInstance(config.instances[0]!, {
        async retireProviderResources() {
            providerRetirements += 1;
            cleanupEntered.resolve();
            await releaseCleanup.promise;
            // This is deliberately a name-addressed resource, like the actual
            // provider cleanup: an early replacement would be deleted here.
            await rm(resource);
        },
    });
    await original.supervision.lifecycle.start();
    assert.equal(original.supervision.snapshot().ready, true);
    const registry = new InstanceRegistry([original]);
    const changes = new InstanceChangeHub();
    const store = new ControlConfigStore();
    const engine = new ConfigEngine({
        configStore: store,
        homeDirectory: home,
        getConfig: () => config,
        setConfig: (next) => { config = next; },
    });
    const runtime = {
        createRuntimeInstance(next: ControlConfig["instances"][number]) {
            writeFileSync(resource, "new generation");
            return createTestInstance(next);
        },
        finalizeRuntimeInstance: async (descriptor: typeof original) => descriptor.close(),
        engine, instanceChanges: changes, instanceRegistry: registry,
    };
    const editor = new InstanceEditorCoordinator({
        ...runtime, cleanupDebtFile: new ControlPathHome(home).lifecycleCleanupFile,
    });
    const creator = new InstanceCreateCoordinator({
        ...runtime,
        assertCleanupSettled(name, reconcile) {
            creationEntered.resolve();
            return editor.assertInstanceCleanupSettled(name, reconcile);
        },
    });
    t.after(async () => {
        releaseCleanup.resolve();
        for (const descriptor of registry.list()) await descriptor.close();
        await original.close();
        await rm(home, { recursive: true, force: true });
    });
    const deletion = editor.deleteInstance({ instanceName: draft.name });
    try {
        await cleanupEntered.promise;
        assert.equal(registry.get(draft.name), undefined);
        assert.deepEqual(config.instances, []);
        const recovery = editor.reconcileCleanupDebt(draft.name);
        const creation = creator.createInstance(draft);
        await creationEntered.promise;
        // Check the fence directly instead of inferring a blocked promise
        // from a sleep. Creation's runtime factory must still be untouched.
        await assert.rejects(editor.assertInstanceCleanupSettled(draft.name, false), {
            code: "instance.conflict",
        });
        assert.equal(await readFile(resource, "utf8"), "old generation");
        assert.equal(providerRetirements, 1);
        releaseCleanup.resolve();
        const [deleted, , created] = await Promise.all([deletion, recovery, creation]);
        assert.equal((deleted as Record<string, unknown>).cleanupPending, false);
        assert.equal(created.name, draft.name);
        const replacement = registry.get(draft.name);
        assert.ok(replacement);
        assert.notEqual(replacement, original);
        await replacement.supervision.lifecycle.start();
        await editor.reconcileCleanupDebt(draft.name);
        assert.equal(providerRetirements, 1);
        assert.equal(await readFile(resource, "utf8"), "new generation");
        assert.equal(registry.get(draft.name), replacement);
        assert.equal(replacement.supervision.snapshot().ready, true);
        assert.deepEqual(await editor.listCleanupDebts(), []);
        assert.equal((await store.readOrCreate(home)).instances[0]?.name, draft.name);
    } finally {
        releaseCleanup.resolve();
        await deletion;
    }
});

function cleanupGate(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}
