import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import {
    EXTENSION_API_VERSION,
    type ExtensionContext,
    type ExtensionPointDeclaration,
    type ExtensionWorkerSession
} from "@portable-devshell/extension";
import { nativeCommands } from "@portable-devshell/extension/cli";
import { applications } from "@portable-devshell/extension/web";

import { createControlExtensionPointRegistry } from "../../../src/composition/ControlExtensionPointRegistry.ts";

import { ExtensionLoader, type ExtensionWorkerRuntime } from "../../../src/control/extension/host/generation/ExtensionLoader.ts";
import { ExtensionPathLayout } from "../../../src/control/extension/state/ExtensionPathLayout.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

interface LoaderHarness {
    cleanup(): Promise<void>;
    paths: ExtensionPathLayout;
    root: string;
    writeGeneration(input?: {
        apiVersion?: number;
        capabilities?: string[];
        extensions?: Record<string, readonly ExtensionPointDeclaration[]>;
        generation?: string;
        id?: string;
        manifestId?: string;
    }): Promise<{ generation: string; id: string }>;
}

async function createHarness(): Promise<LoaderHarness> {
    const root = await createTestTempDirectory("extension-loader");
    const paths = new ExtensionPathLayout({
        dataHome: join(root, "data"),
        homeDirectory: join(root, "home"),
        runtimeRoot: join(root, "runtime")
    });
    return {
        cleanup: async () => await rm(root, { force: true, recursive: true }),
        paths,
        root,
        async writeGeneration(input = {}) {
            const id = input.id ?? "example";
            const generation = input.generation ?? "1.0.0-a";
            const directory = paths.generationDirectory(id, generation);
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, "devshell-extension.json"), `${JSON.stringify({
                apiVersion: input.apiVersion ?? EXTENSION_API_VERSION,
                capabilities: input.capabilities ?? [],
                entry: "extension.mjs",
                extensions: input.extensions ?? {},
                id: input.manifestId ?? id,
                name: "Example",
                schemaVersion: 1,
                version: "1.0.0"
            })}\n`, "utf8");
            await writeFile(join(directory, "extension.mjs"), "export function activate() {}\n", "utf8");
            return { generation, id };
        }
    };
}

function fakeWorker(events: string[]): ExtensionWorkerRuntime {
    return {
        async closeAll() { events.push("worker.closeAll"); },
        async openSession(): Promise<ExtensionWorkerSession> {
            events.push("worker.openSession");
            let resolveClosed!: () => void;
            const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
            let isClosed = false;
            return {
                closed,
                async callTool() { return {}; },
                async close() {
                    if (isClosed) return;
                    isClosed = true;
                    resolveClosed();
                },
                environment: {
                    homeDirectory: "/home/test",
                    platform: { arch: "x64", os: "linux" },
                },
                instance: "local",
                listTools: () => [],
                workspace: "/repo"
            };
        },
        async retireInstance(instance) { events.push(`worker.retire:${instance}`); }
    };
}

test("Extension loader reads and validates a generation manifest without activating code or creating runtime state", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const { id, generation } = await harness.writeGeneration({
        extensions: { "cli.native-commands": [{ id: "example", title: "Example" }] }
    });
    let imports = 0;
    const loader = new ExtensionLoader({
        importer: async () => {
            imports += 1;
            return { activate() {} };
        },
        instances: { list: () => [] } as never,
        paths: harness.paths,
        points: createControlExtensionPointRegistry(),
    });

    const manifest = await loader.readManifest(id, generation);

    assert.equal(manifest.id, id);
    assert.deepEqual(manifest.extensions, {
        "cli.native-commands": [{ id: "example", title: "Example" }]
    });
    assert.equal(imports, 0);
    await assert.rejects(access(harness.paths.runtimeDirectory(id, generation)));
    await assert.rejects(access(harness.paths.dataDirectory(id)));
    await assert.rejects(access(harness.paths.stateDirectory(id)));
});

test("Extension loader returns a ready invisible candidate with narrow immutable v4 context", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const { id, generation } = await harness.writeGeneration({
        capabilities: ["workers"],
        extensions: { "cli.native-commands": [{ id: "example", title: "Example" }] }
    });
    const events: string[] = [];
    let seenContext: ExtensionContext | undefined;
    const loader = new ExtensionLoader({
        importer: async () => ({
            activate(context: ExtensionContext): void {
                seenContext = context;
                context.register(nativeCommands, "example", async () => ({ kind: "json", value: { pong: true } }));
            },
            deactivate() { events.push("module.deactivate"); }
        }),
        instances: { list: () => [] } as never,
        paths: harness.paths,
        points: createControlExtensionPointRegistry(),
        workerFactory: () => fakeWorker(events)
    });

    const candidate = await loader.load(id, generation);

    assert.equal(candidate.state, "ready");
    assert.equal(candidate.manifest.id, "example");
    assert.equal(Object.isFrozen(seenContext), true);
    assert.equal(Object.isFrozen(seenContext?.paths), true);
    assert.equal(Object.isFrozen(seenContext?.capabilities), true);
    assert.equal(seenContext?.id, id);
    assert.equal(seenContext?.generation, generation);
    assert.equal(seenContext?.capabilities.assets, undefined);
    assert.equal(seenContext?.capabilities.processes, undefined);
    assert.ok(seenContext?.capabilities.workers);
    assert.equal(seenContext?.paths.codeDirectory, harness.paths.generationDirectory(id, generation));
    assert.equal(seenContext?.paths.stateDirectory, harness.paths.stateDirectory(id));
    assert.equal(dirname(seenContext!.paths.runtimeDirectory), harness.paths.runtimeDirectory(id, generation));
    candidate.activate();
    const lease = candidate.acquire();
    const registration = lease.registrations.get("cli.native-commands", "example");
    assert.ok(registration);
    assert.deepEqual(await (registration.binding as (argv: readonly string[], context: unknown) => Promise<unknown>)([], {}), {
        kind: "json",
        value: { pong: true }
    });
    lease.release();
    await candidate.retire();
    assert.deepEqual(events, ["module.deactivate", "worker.closeAll"]);
    await assert.rejects(access(harness.paths.runtimeDirectory(id, generation)));
});

test("Extension loader isolates runtime directories for overlapping loads of the same code generation", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const { id, generation } = await harness.writeGeneration();
    const runtimeDirectories: string[] = [];
    const loader = new ExtensionLoader({
        importer: async () => ({
            async activate(context: ExtensionContext): Promise<void> {
                runtimeDirectories.push(context.paths.runtimeDirectory);
                await writeFile(join(context.paths.runtimeDirectory, "marker.txt"), context.paths.runtimeDirectory, "utf8");
            }
        }),
        instances: { list: () => [] } as never,
        paths: harness.paths,
        points: createControlExtensionPointRegistry(),
    });

    const first = await loader.load(id, generation);
    const firstRuntime = runtimeDirectories[0]!;
    const second = await loader.load(id, generation);
    const secondRuntime = runtimeDirectories[1]!;

    assert.notEqual(firstRuntime, secondRuntime);
    assert.equal(dirname(firstRuntime), harness.paths.runtimeDirectory(id, generation));
    assert.equal(dirname(secondRuntime), harness.paths.runtimeDirectory(id, generation));
    await access(join(firstRuntime, "marker.txt"));
    await access(join(secondRuntime, "marker.txt"));

    await first.retire();
    await assert.rejects(access(firstRuntime));
    await access(join(secondRuntime, "marker.txt"));

    await second.retire();
    await assert.rejects(access(secondRuntime));
    await assert.rejects(access(harness.paths.runtimeDirectory(id, generation)));
});

test("Extension loader rejects incompatible API without owning the CLI command namespace", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const incompatible = await harness.writeGeneration({ apiVersion: EXTENSION_API_VERSION + 1 });
    const cliNamedExtension = await harness.writeGeneration({ id: "status" });
    let imports = 0;
    const loader = new ExtensionLoader({
        importer: async () => {
            imports += 1;
            return {};
        },
        instances: { list: () => [] } as never,
        paths: harness.paths,
        points: createControlExtensionPointRegistry(),
    });

    await assert.rejects(loader.load(incompatible.id, incompatible.generation), /Unsupported Extension apiVersion/u);
    assert.equal((await loader.readManifest(cliNamedExtension.id, cliNamedExtension.generation)).id, "status");
    assert.equal(imports, 0);
});

test("Extension loader rejects manifest identity mismatch", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const target = await harness.writeGeneration({ manifestId: "other" });
    const loader = new ExtensionLoader({
        importer: async () => ({ activate() {} }),
        instances: { list: () => [] } as never,
        paths: harness.paths,
        points: createControlExtensionPointRegistry(),
    });

    await assert.rejects(loader.load(target.id, target.generation), /declares id other/u);
});

test("Extension loader rolls back Worker resources and runtime directory when activate throws", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const target = await harness.writeGeneration({ capabilities: ["workers"] });
    const events: string[] = [];
    const loader = new ExtensionLoader({
        importer: async () => ({
            async activate(context: ExtensionContext) {
                await context.capabilities.workers!.openSession({ workspace: "/repo" });
                throw new Error("activation failed");
            }
        }),
        instances: { list: () => [] } as never,
        paths: harness.paths,
        points: createControlExtensionPointRegistry(),
        workerFactory: () => fakeWorker(events)
    });

    await assert.rejects(loader.load(target.id, target.generation), /activation failed/u);
    assert.deepEqual(events, ["worker.openSession", "worker.closeAll"]);
    await assert.rejects(access(harness.paths.runtimeDirectory(target.id, target.generation)));
});

test("Extension loader deactivates a module before rejecting an undeclared runtime binding", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const target = await harness.writeGeneration();
    const events: string[] = [];
    const loader = new ExtensionLoader({
        importer: async () => ({
            activate(context: ExtensionContext) {
                context.register(nativeCommands, "example", async () => ({ kind: "text", text: "should not register" }));
            },
            deactivate() { events.push("module.deactivate"); }
        }),
        instances: { list: () => [] } as never,
        paths: harness.paths,
        points: createControlExtensionPointRegistry(),
        workerFactory: () => fakeWorker(events)
    });

    await assert.rejects(loader.load(target.id, target.generation), /registered undeclared cli\.native-commands\/example/u);
    assert.deepEqual(events, ["module.deactivate"]);
});

test("Extension loader keeps internal Worker retirement active without an Extension lifecycle callback", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const target = await harness.writeGeneration({ capabilities: ["workers"] });
    const events: string[] = [];
    const loader = new ExtensionLoader({
        importer: async () => ({ activate() {} }),
        instances: { list: () => [] } as never,
        paths: harness.paths,
        points: createControlExtensionPointRegistry(),
        workerFactory: () => fakeWorker(events)
    });
    const candidate = await loader.load(target.id, target.generation);
    candidate.activate();

    await candidate.retireInstanceResources("local");

    assert.deepEqual(events, ["worker.retire:local"]);
    await candidate.retire();
});

test("Extension loader rejects Web file bindings escaping the immutable generation", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const target = await harness.writeGeneration({
        extensions: { "web.applications": [{ id: "example", title: "Example" }] }
    });
    const events: string[] = [];
    const loader = new ExtensionLoader({
        importer: async () => ({
            activate(context: ExtensionContext) {
                context.register(applications, "example", {
                    source: { directory: "../outside", kind: "files" }
                });
            },
            deactivate() { events.push("module.deactivate"); }
        }),
        instances: { list: () => [] } as never,
        paths: harness.paths,
        points: createControlExtensionPointRegistry(),
        workerFactory: () => fakeWorker(events)
    });

    await assert.rejects(loader.load(target.id, target.generation), /escapes the Extension code directory/u);
    assert.deepEqual(events, ["module.deactivate"]);
});
