import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createArtifactDirectoryArchive } from "../../../src/control/artifact/host/ArtifactHostArchive.ts";
import { ExtensionHost } from "../../../src/control/extension/ExtensionHost.ts";
import { ExtensionInstallService } from "../../../src/control/extension/ExtensionInstallService.ts";
import { ExtensionLoader } from "../../../src/control/extension/ExtensionLoader.ts";
import { ExtensionPathLayout } from "../../../src/control/extension/ExtensionPathLayout.ts";
import { ExtensionRegistryStore } from "../../../src/control/extension/ExtensionRegistryStore.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

interface Harness {
    cleanup(): Promise<void>;
    host: ExtensionHost;
    paths: ExtensionPathLayout;
    root: string;
    service: ExtensionInstallService;
    source(name: string, options?: { body?: string; version?: string }): Promise<string>;
}

async function harness(t: test.TestContext, limits = {}): Promise<Harness> {
    const root = await createTestTempDirectory("extension-install");
    const paths = new ExtensionPathLayout({
        dataHome: join(root, "data"),
        homeDirectory: join(root, "home"),
        runtimeRoot: join(root, "runtime")
    });
    const host = new ExtensionHost({
        loader: new ExtensionLoader({
            instances: { list: () => [] } as never,
            paths
        }),
        registry: new ExtensionRegistryStore(paths.registryFile)
    });
    await host.start();
    const cleanup = async () => {
        await host.stop().catch(() => undefined);
        await rm(root, { force: true, recursive: true });
    };
    t.after(cleanup);
    return {
        cleanup,
        host,
        paths,
        root,
        service: new ExtensionInstallService({ host, limits, paths }),
        async source(name, options = {}) {
            const source = join(root, name);
            await mkdir(source, { recursive: true });
            await writeFile(join(source, "devshell-extension.json"), `${JSON.stringify({
                apiVersion: 1,
                capabilities: ["rpc"],
                entry: "extension.mjs",
                id: "example",
                name: "Example",
                schemaVersion: 1,
                version: options.version ?? "1.0.0"
            })}\n`, "utf8");
            await writeFile(join(source, "extension.mjs"), options.body ?? [
                "export async function activate() {",
                "  return {",
                "    rpc: { ping: async () => ({ version: '1.0.0' }) },",
                "    dispose() {}",
                "  };",
                "}",
                ""
            ].join("\n"), "utf8");
            return source;
        }
    };
}

test("Extension install materializes a directory as an immutable content-addressed generation and activates it", async (t) => {
    const h = await harness(t);
    const source = await h.source("source-v1");

    const installed = await h.service.install(source);

    assert.equal(installed.id, "example");
    assert.equal(installed.state, "active");
    assert.match(installed.activeGeneration ?? "", /^v1\.0\.0-[0-9a-f]{64}$/u);
    assert.equal(installed.selectedGeneration, installed.activeGeneration);
    assert.equal(installed.lastKnownGoodGeneration, installed.activeGeneration);
    assert.deepEqual(await h.host.dispatchRpc("example", "ping", undefined, {
        requestId: "ping-1",
        signal: new AbortController().signal
    }), { version: "1.0.0" });
    const generationDirectory = h.paths.generationDirectory("example", installed.activeGeneration!);
    assert.equal((await stat(join(generationDirectory, "extension.mjs"))).isFile(), true);
    assert.equal((await readdir(h.paths.codeRoot)).some((name) => name.startsWith(".staging-")), false);
});

test("Extension install accepts the hardened .dsext archive and ignores mtime in generation identity", async (t) => {
    const h = await harness(t);
    const source = await h.source("archive-source");
    const bundle = join(h.root, "example.dsext");
    await createArtifactDirectoryArchive(source, bundle);

    const first = await h.service.install(bundle);
    const now = new Date(Date.now() + 60_000);
    await utimes(join(source, "extension.mjs"), now, now);
    const secondBundle = join(h.root, "example-new-mtime.dsext");
    await createArtifactDirectoryArchive(source, secondBundle);
    const second = await h.service.install(secondBundle);

    assert.equal(second.activeGeneration, first.activeGeneration);
    assert.deepEqual(await readdir(join(h.paths.codeRoot, "example")), [first.activeGeneration]);
});

test("Extension .dsext round-trips multi-chunk file bytes exactly", async (t) => {
    const h = await harness(t);
    const source = await h.source("archive-multichunk");
    const chunkSize = 64 * 1024;
    const payload = Buffer.alloc(chunkSize * 3 + 123);
    payload.fill(0x11, 0, chunkSize);
    payload.fill(0x22, chunkSize, chunkSize * 2);
    payload.fill(0x33, chunkSize * 2, chunkSize * 3);
    payload.fill(0x44, chunkSize * 3);
    await writeFile(join(source, "payload.bin"), payload);
    const bundle = join(h.root, "multichunk.dsext");
    await createArtifactDirectoryArchive(source, bundle);

    const installed = await h.service.install(bundle);
    const installedPayload = await readFile(join(
        h.paths.generationDirectory("example", installed.activeGeneration!),
        "payload.bin"
    ));

    assert.deepEqual(installedPayload, payload);
});

test("Extension candidate activation failure removes only the new generation and preserves the active one", async (t) => {
    const h = await harness(t);
    const goodSource = await h.source("good", { version: "1.0.0" });
    const good = await h.service.install(goodSource);
    const badSource = await h.source("bad", {
        body: "export async function activate() { throw new Error('bad activation'); }\n",
        version: "2.0.0"
    });

    await assert.rejects(h.service.install(badSource), /bad activation/u);

    const records = await h.host.list();
    assert.equal(records[0]?.activeGeneration, good.activeGeneration);
    assert.deepEqual(await h.host.dispatchRpc("example", "ping", undefined, {
        requestId: "ping-after-failure",
        signal: new AbortController().signal
    }), { version: "1.0.0" });
    assert.deepEqual(await readdir(join(h.paths.codeRoot, "example")), [good.activeGeneration]);
});

test("Extension install enforces logical source limits before materialization", async (t) => {
    const h = await harness(t, { maxFileBytes: 32 });
    const source = await h.source("oversized", {
        body: "export async function activate() { return { dispose() {} }; }\n"
    });

    await assert.rejects(h.service.install(source), /file exceeds the byte limit/u);
    assert.deepEqual(await h.host.list(), []);
    assert.equal((await readdir(h.paths.codeRoot)).some((name) => name.startsWith(".staging-")), false);
});

test("Extension install enforces extraction budgets for .dsext archives", async (t) => {
    const h = await harness(t);
    const source = await h.source("archive-oversized", {
        body: `${"// payload padding\n".repeat(16)}export async function activate() { return { dispose() {} }; }\n`
    });
    const bundle = join(h.root, "oversized.dsext");
    await createArtifactDirectoryArchive(source, bundle);
    const constrained = new ExtensionInstallService({
        host: h.host,
        limits: { maxFileBytes: 96 },
        paths: h.paths
    });

    await assert.rejects(constrained.install(bundle), /file limit/u);
    assert.deepEqual(await h.host.list(), []);
    assert.equal((await readdir(h.paths.codeRoot)).some((name) => name.startsWith(".staging-")), false);
});

test("Extension remove disables routing, waits for the leased generation to drain, then deletes code but preserves state", async (t) => {
    const h = await harness(t);
    const source = await h.source("drain", {
        body: [
            "export async function activate() {",
            "  return {",
            "    rpc: { hold: async () => await globalThis.__devshellExtensionHold },",
            "    dispose() { globalThis.__devshellExtensionDisposed = true; }",
            "  };",
            "}",
            ""
        ].join("\n")
    });
    const installed = await h.service.install(source);
    let releaseHold!: () => void;
    (globalThis as Record<string, unknown>).__devshellExtensionHold = new Promise<void>((resolve) => {
        releaseHold = resolve;
    });
    (globalThis as Record<string, unknown>).__devshellExtensionDisposed = false;
    const active = h.host.dispatchRpc("example", "hold", undefined, {
        requestId: "hold",
        signal: new AbortController().signal
    });
    await writeFile(join(h.paths.stateDirectory("example"), "state.txt"), "keep\n", "utf8");

    let removed = false;
    const removal = h.service.remove("example").then((value) => {
        removed = true;
        return value;
    });
    await waitFor(async () => (await h.host.list())[0]?.state === "disabled");
    assert.equal(removed, false);
    assert.equal(await exists(h.paths.generationDirectory("example", installed.activeGeneration!)), true);
    await assert.rejects(
        h.host.dispatchRpc("example", "hold", undefined, {
            requestId: "new-hold",
            signal: new AbortController().signal
        }),
        /not active/u
    );

    releaseHold();
    await active;
    assert.deepEqual(await removal, { id: "example", purged: false, removed: true });
    assert.equal((globalThis as Record<string, unknown>).__devshellExtensionDisposed, true);
    assert.equal(await exists(join(h.paths.codeRoot, "example")), false);
    assert.equal(await exists(join(h.paths.stateDirectory("example"), "state.txt")), true);
    assert.deepEqual(await h.host.list(), []);
    delete (globalThis as Record<string, unknown>).__devshellExtensionHold;
    delete (globalThis as Record<string, unknown>).__devshellExtensionDisposed;
});

test("Extension remove --purge deletes mutable state after the runtime has drained", async (t) => {
    const h = await harness(t);
    await h.service.install(await h.source("purge"));
    await writeFile(join(h.paths.stateDirectory("example"), "state.txt"), "purge\n", "utf8");

    assert.deepEqual(await h.service.remove("example", true), {
        id: "example",
        purged: true,
        removed: true
    });
    assert.equal(await exists(h.paths.stateDirectory("example")), false);
});

async function exists(path: string): Promise<boolean> {
    return await access(path).then(() => true, () => false);
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for Extension install state transition.");
}
