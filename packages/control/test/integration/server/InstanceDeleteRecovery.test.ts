import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { dirname } from "node:path";

import {
    Endpoint,
    LocalChannel,
    ControlPathHome,
    createInstanceTransport,
    createProcessTransport,
    createServerTransport,
    normalizeConfigInstanceDraft,
    toConfigInstanceDraft,
} from "@portable-devshell/shared";

import { Control } from "../../../src/Control.ts";
import { ControlFactory } from "../../../src/Factory.ts";
import { ControlConfigStore } from "../../../src/config/store/index.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { resolveTestWorkerBinary } from "../../../../../test/TestPlatformSupport.ts";

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
