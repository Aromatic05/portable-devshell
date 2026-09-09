import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { EXTENSION_API_VERSION } from "@portable-devshell/extension";

import { createArtifactDirectoryArchive } from "../../../src/control/artifact/host/ArtifactHostArchive.ts";
import { ExtensionHost } from "../../../src/control/extension/host/ExtensionHost.ts";
import { ExtensionInstallService } from "../../../src/control/extension/install/ExtensionInstallService.ts";
import { ExtensionLoader } from "../../../src/control/extension/host/generation/ExtensionLoader.ts";
import { ExtensionPathLayout } from "../../../src/control/extension/state/ExtensionPathLayout.ts";
import { ExtensionRegistryStore } from "../../../src/control/extension/state/ExtensionRegistryStore.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

interface Harness {
    cleanup(): Promise<void>;
    host: ExtensionHost;
    paths: ExtensionPathLayout;
    root: string;
    service: ExtensionInstallService;
    source(name: string, options?: {
        body?: string;
        hostDependencies?: string[];
        id?: string;
        version?: string;
    }): Promise<string>;
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
            const id = options.id ?? "example";
            await mkdir(source, { recursive: true });
            await writeFile(join(source, "devshell-extension.json"), `${JSON.stringify({
                apiVersion: EXTENSION_API_VERSION,
                capabilities: [],
                entry: "extension.mjs",
                extensions: {
                    "cli.commands": [{ id, title: id }]
                },
                ...(options.hostDependencies === undefined ? {} : { hostDependencies: options.hostDependencies }),
                id,
                name: options.id === "skill" ? "Skill" : "Example",
                schemaVersion: 1,
                version: options.version ?? "1.0.0"
            })}\n`, "utf8");
            await writeFile(join(source, "extension.mjs"), options.body ?? [
                "export function activate(context) {",
                `  context.register({ id: 'cli.commands' }, ${JSON.stringify(id)}, async () => ({ kind: 'json', value: { version: '1.0.0' } }));`,
                "}",
                ""
            ].join("\n"), "utf8");
            return source;
        }
    };
}

async function invokeCliRegistration(
    host: ExtensionHost,
    id: string,
    requestId: string
): Promise<unknown> {
    const { lease, registration } = await host.acquireRegistration("cli.commands", id);
    try {
        assert.equal(typeof registration.binding, "function");
        return await Reflect.apply(registration.binding as (...args: unknown[]) => unknown, undefined, [
            [],
            {
                localOwner: false,
                requestId,
                signal: new AbortController().signal
            }
        ]);
    } finally {
        lease.release();
    }
}

test("Extension install materializes, validates, and selects an immutable generation without keeping it active", async (t) => {
    const h = await harness(t);
    const source = await h.source("source-v1");

    const installed = await h.service.install(source);

    assert.equal(installed.id, "example");
    assert.equal(installed.state, "installed");
    assert.equal(installed.activeGeneration, undefined);
    assert.match(installed.selectedGeneration ?? "", /^v1\.0\.0-[0-9a-f]{64}$/u);
    assert.equal(installed.lastKnownGoodGeneration, installed.selectedGeneration);
    const generation = installed.selectedGeneration!;
    assert.deepEqual(
        await invokeCliRegistration(h.host, "example", "ping-1"),
        { kind: "json", value: { version: "1.0.0" } }
    );
    assert.equal((await h.host.list())[0]?.activeGeneration, generation);
    const generationDirectory = h.paths.generationDirectory("example", generation);
    assert.equal((await stat(join(generationDirectory, "extension.mjs"))).isFile(), true);
    assert.equal((await readdir(h.paths.codeRoot)).some((name) => name.startsWith(".staging-")), false);
});

test("builtin Extension identity cannot be replaced by ordinary install", async (t) => {
    const h = await harness(t);
    const source = await h.source("builtin-skill", { id: "skill" });

    await assert.rejects(h.service.install(source), /reserved for a builtin Extension/u);
    await assert.rejects(
        h.service.install(await h.source("builtin-secret", { id: "secret" })),
        /reserved for a builtin Extension/u
    );
    const installed = await h.service.installBuiltin("skill", source);

    assert.equal(installed.id, "skill");
    assert.equal(installed.state, "installed");
    assert.equal(installed.activeGeneration, undefined);
    await assert.rejects(
        h.service.installBuiltin("skill", await h.source("wrong-builtin", { id: "example" })),
        /declares id example, expected skill/u
    );
    await assert.rejects(
        h.service.installBuiltin("unknown", source),
        /is not a registered builtin/u
    );
});

test("reinstalling the selected builtin generation preserves lazy startup until first invocation", async (t) => {
    const h = await harness(t);
    const source = await h.source("builtin-skill-lazy", { id: "skill" });
    const first = await h.service.installBuiltin("skill", source);
    assert.equal(first.state, "installed");
    assert.equal(first.activeGeneration, undefined);
    await h.host.stop();

    const host = new ExtensionHost({
        loader: new ExtensionLoader({
            instances: { list: () => [] } as never,
            paths: h.paths
        }),
        registry: new ExtensionRegistryStore(h.paths.registryFile)
    });
    await host.start();
    t.after(async () => await host.stop().catch(() => undefined));
    assert.equal((await host.list())[0]?.state, "installed");
    assert.equal((await host.list())[0]?.activeGeneration, undefined);

    const service = new ExtensionInstallService({ host, paths: h.paths });
    const repeated = await service.installBuiltin("skill", source);

    assert.equal(repeated.state, "installed");
    assert.equal(repeated.activeGeneration, undefined);
    assert.equal(repeated.selectedGeneration, first.selectedGeneration);
    assert.deepEqual(
        await invokeCliRegistration(host, "skill", "lazy-builtin"),
        { kind: "json", value: { version: "1.0.0" } }
    );
    assert.equal((await host.list())[0]?.state, "active");
});

test("builtin Extension generation resolves host runtime dependencies without copying node_modules", async (t) => {
    const h = await harness(t);
    const source = await h.source("builtin-mcp-host-dependency", {
        body: [
            'import { Client } from "@modelcontextprotocol/client";',
            "export function activate(context) {",
            "  context.register({ id: 'cli.commands' }, 'mcp', async () => ({ kind: 'json', value: { clientType: typeof Client } }));",
            "}",
            ""
        ].join("\n"),
        hostDependencies: ["@modelcontextprotocol/client"],
        id: "mcp"
    });

    const installed = await h.service.installBuiltin("mcp", source);

    assert.equal(installed.state, "installed");
    assert.equal(installed.activeGeneration, undefined);
    assert.deepEqual(
        await invokeCliRegistration(h.host, "mcp", "host-dependency"),
        { kind: "json", value: { clientType: "function" } }
    );
    assert.equal((await h.host.list())[0]?.activeGeneration, installed.selectedGeneration);
    assert.equal(await exists(join(
        h.paths.generationDirectory("mcp", installed.selectedGeneration!),
        "node_modules",
        "@modelcontextprotocol",
        "client"
    )), false);
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

    assert.equal(second.selectedGeneration, first.selectedGeneration);
    assert.equal(second.activeGeneration, undefined);
    assert.deepEqual(await readdir(join(h.paths.codeRoot, "example")), [first.selectedGeneration]);
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
        h.paths.generationDirectory("example", installed.selectedGeneration!),
        "payload.bin"
    ));

    assert.deepEqual(installedPayload, payload);
});

test("Extension candidate activation failure removes only the new generation and preserves the active one", async (t) => {
    const h = await harness(t);
    const goodSource = await h.source("good", { version: "1.0.0" });
    const good = await h.service.install(goodSource);
    assert.deepEqual(
        await invokeCliRegistration(h.host, "example", "activate-good-before-upgrade"),
        { kind: "json", value: { version: "1.0.0" } }
    );
    assert.equal((await h.host.list())[0]?.activeGeneration, good.selectedGeneration);
    const badSource = await h.source("bad", {
        body: "export async function activate() { throw new Error('bad activation'); }\n",
        version: "2.0.0"
    });

    await assert.rejects(h.service.install(badSource), /bad activation/u);

    const records = await h.host.list();
    assert.equal(records[0]?.activeGeneration, good.selectedGeneration);
    assert.equal(records[0]?.selectedGeneration, good.selectedGeneration);
    assert.deepEqual(
        await invokeCliRegistration(h.host, "example", "ping-after-failure"),
        { kind: "json", value: { version: "1.0.0" } }
    );
    assert.deepEqual(await readdir(join(h.paths.codeRoot, "example")), [good.selectedGeneration]);
});

test("Extension install enforces logical source limits before materialization", async (t) => {
    const h = await harness(t, { maxFileBytes: 32 });
    const source = await h.source("oversized", {
        body: "export function activate() {}\n"
    });

    await assert.rejects(h.service.install(source), /file exceeds the byte limit/u);
    assert.deepEqual(await h.host.list(), []);
    assert.equal((await readdir(h.paths.codeRoot)).some((name) => name.startsWith(".staging-")), false);
});

test("Extension install rejects private node_modules trees in favor of hostDependencies", async (t) => {
    const h = await harness(t);
    const source = await h.source("private-node-modules");
    const dependencyDirectory = join(source, "node_modules", "example-dependency");
    await mkdir(dependencyDirectory, { recursive: true });
    await writeFile(join(dependencyDirectory, "index.js"), "export default 1;\n", "utf8");

    await assert.rejects(
        h.service.install(source),
        /shared host dependencies instead of private node_modules/u
    );
    assert.deepEqual(await h.host.list(), []);
});

test("Extension install enforces extraction budgets for .dsext archives", async (t) => {
    const h = await harness(t);
    const source = await h.source("archive-oversized", {
        body: `${"// payload padding\n".repeat(16)}export function activate() {}\n`
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
            "import { watch, writeFileSync } from 'node:fs';",
            "import { join } from 'node:path';",
            "let disposedFile;",
            "export async function activate(context) {",
            "  const stateDirectory = context.paths.stateDirectory;",
            "  const releaseFile = join(stateDirectory, 'release.txt');",
            "  disposedFile = join(stateDirectory, 'disposed.txt');",
            "  let releaseHold;",
            "  const hold = new Promise((resolve) => { releaseHold = resolve; });",
            "  const watcher = watch(stateDirectory, (_event, file) => {",
            "    if (file !== 'release.txt') return;",
            "    watcher.close();",
            "    releaseHold();",
            "  });",
            "  context.register({ id: 'cli.commands' }, 'example', async () => {",
            "    await hold;",
            "    return { kind: 'text', text: 'released' };",
            "  });",
            "}",
            "export function deactivate() { writeFileSync(disposedFile, 'disposed\\n'); }",
            ""
        ].join("\n")
    });
    const installed = await h.service.install(source);
    const active = invokeCliRegistration(h.host, "example", "hold");
    await waitFor(async () => (await h.host.list())[0]?.state === "active");
    await writeFile(join(h.paths.stateDirectory("example"), "state.txt"), "keep\n", "utf8");

    let removed = false;
    const removal = h.service.remove("example").then((value) => {
        removed = true;
        return value;
    });
    await waitFor(async () => (await h.host.list())[0]?.state === "disabled");
    assert.equal(removed, false);
    assert.equal(await exists(h.paths.generationDirectory("example", installed.selectedGeneration!)), true);
    await assert.rejects(
        invokeCliRegistration(h.host, "example", "new-hold"),
        /No Extension registration/u
    );

    await writeFile(join(h.paths.stateDirectory("example"), "release.txt"), "release\n", "utf8");
    await active;
    assert.deepEqual(await removal, { id: "example", purged: false, removed: true });
    assert.equal(await readFile(join(h.paths.stateDirectory("example"), "disposed.txt"), "utf8"), "disposed\n");
    assert.equal(await exists(join(h.paths.codeRoot, "example")), false);
    assert.equal(await exists(join(h.paths.stateDirectory("example"), "state.txt")), true);
    assert.deepEqual(await h.host.list(), []);
});

test("Extension remove surfaces dispose failure before deleting the installed generation", async (t) => {
    const h = await harness(t);
    const source = await h.source("dispose-failure", {
        body: [
            "import { existsSync } from 'node:fs';",
            "import { join } from 'node:path';",
            "let stateDirectory;",
            "export function activate(context) {",
            "  stateDirectory = context.paths.stateDirectory;",
            "  context.register({ id: 'cli.commands' }, 'example', async () => ({ kind: 'text', text: 'ok' }));",
            "}",
            "export function deactivate() {",
            "  if (existsSync(join(stateDirectory, 'fail-dispose'))) throw new Error('dispose failed during remove');",
            "}",
            ""
        ].join("\n")
    });
    const installed = await h.service.install(source);
    const generationDirectory = h.paths.generationDirectory("example", installed.selectedGeneration!);
    await writeFile(join(h.paths.stateDirectory("example"), "fail-dispose"), "fail\n", "utf8");
    assert.deepEqual(
        await invokeCliRegistration(h.host, "example", "activate-dispose-failure"),
        { kind: "text", text: "ok" }
    );

    await assert.rejects(
        h.service.remove("example"),
        (error: unknown) => error instanceof AggregateError
            && error.errors.some((candidate) => (
                candidate instanceof Error && /dispose failed during remove/u.test(candidate.message)
            ))
    );

    assert.equal(await exists(generationDirectory), true);
    assert.equal((await h.host.list())[0]?.state, "disabled");
});

test("Extension remove --purge deletes mutable state after the runtime has drained", async (t) => {
    const h = await harness(t);
    await h.service.install(await h.source("purge"));
    await writeFile(join(h.paths.stateDirectory("example"), "state.txt"), "purge\n", "utf8");
    await mkdir(h.paths.dataDirectory("example"), { recursive: true });
    await writeFile(join(h.paths.dataDirectory("example"), "data.txt"), "purge data\n", "utf8");

    assert.deepEqual(await h.service.remove("example", true), {
        id: "example",
        purged: true,
        removed: true
    });
    assert.equal(await exists(h.paths.stateDirectory("example")), false);
    assert.equal(await exists(h.paths.dataDirectory("example")), false);
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
