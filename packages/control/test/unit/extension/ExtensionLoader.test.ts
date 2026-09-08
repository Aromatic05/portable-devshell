import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { EXTENSION_API_VERSION } from "@portable-devshell/extension";
import type {
    ExtensionActivation,
    ExtensionContext,
    ExtensionWorkerSession
} from "@portable-devshell/extension";

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
                capabilities: input.capabilities ?? ["rpc"],
                entry: "extension.mjs",
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
            return {
                async callTool() { return {}; },
                async close() {},
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

test("Extension loader returns a ready invisible candidate with narrow immutable v2 context", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const { id, generation } = await harness.writeGeneration({ capabilities: ["rpc", "worker"] });
    const events: string[] = [];
    let seenContext: ExtensionContext | undefined;
    const loader = new ExtensionLoader({
        importer: async () => ({
            activate(context: ExtensionContext): ExtensionActivation {
                seenContext = context;
                return {
                    dispose() { events.push("activation.dispose"); },
                    rpc: { ping: async () => ({ pong: true }) }
                };
            }
        }),
        instances: { list: () => [] } as never,
        paths: harness.paths,
        workerFactory: () => fakeWorker(events)
    });

    const candidate = await loader.load(id, generation);

    assert.equal(candidate.state, "ready");
    assert.equal(candidate.manifest.id, "example");
    assert.equal(Object.isFrozen(seenContext), true);
    assert.equal(Object.isFrozen(seenContext?.paths), true);
    assert.equal(seenContext?.id, id);
    assert.equal(seenContext?.generation, generation);
    assert.equal(seenContext?.paths.codeDirectory, harness.paths.generationDirectory(id, generation));
    assert.equal(seenContext?.paths.stateDirectory, harness.paths.stateDirectory(id));
    assert.equal(seenContext?.paths.runtimeDirectory, harness.paths.runtimeDirectory(id, generation));
    candidate.activate();
    const lease = candidate.acquire();
    assert.deepEqual(await lease.activation.rpc?.ping(undefined, {
        localOwner: false,
        requestId: "request-1",
        signal: new AbortController().signal
    }), { pong: true });
    lease.release();
    await candidate.retire();
    assert.deepEqual(events, ["activation.dispose", "worker.closeAll"]);
    await assert.rejects(access(harness.paths.runtimeDirectory(id, generation)));
});

test("Extension loader rejects incompatible API and reserved ids before importing code", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const incompatible = await harness.writeGeneration({ apiVersion: EXTENSION_API_VERSION + 1 });
    let imports = 0;
    const loader = new ExtensionLoader({
        importer: async () => {
            imports += 1;
            return {};
        },
        instances: { list: () => [] } as never,
        paths: harness.paths
    });

    await assert.rejects(loader.load(incompatible.id, incompatible.generation), new RegExp(`API version ${EXTENSION_API_VERSION + 1}`, "u"));
    await assert.rejects(loader.load("status", "1.0.0-a"), /reserved/u);
    assert.equal(imports, 0);
});

test("Extension loader rejects manifest identity mismatch", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const target = await harness.writeGeneration({ manifestId: "other" });
    const loader = new ExtensionLoader({
        importer: async () => ({ activate: () => ({ dispose() {} }) }),
        instances: { list: () => [] } as never,
        paths: harness.paths
    });

    await assert.rejects(loader.load(target.id, target.generation), /declares id other/u);
});

test("Extension loader rolls back Worker resources and runtime directory when activate throws", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const target = await harness.writeGeneration({ capabilities: ["worker"] });
    const events: string[] = [];
    const loader = new ExtensionLoader({
        importer: async () => ({
            async activate(context: ExtensionContext) {
                await context.worker.openSession({ workspace: "/repo" });
                throw new Error("activation failed");
            }
        }),
        instances: { list: () => [] } as never,
        paths: harness.paths,
        workerFactory: () => fakeWorker(events)
    });

    await assert.rejects(loader.load(target.id, target.generation), /activation failed/u);
    assert.deepEqual(events, ["worker.openSession", "worker.closeAll"]);
    await assert.rejects(access(harness.paths.runtimeDirectory(target.id, target.generation)));
});

test("Extension loader disposes an invalid Activation before rejecting undeclared contributions", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const target = await harness.writeGeneration({ capabilities: [] });
    const events: string[] = [];
    const loader = new ExtensionLoader({
        importer: async () => ({
            activate: () => ({
                command: async () => ({ kind: "text", text: "should not register" }),
                dispose() { events.push("activation.dispose"); }
            })
        }),
        instances: { list: () => [] } as never,
        paths: harness.paths,
        workerFactory: () => fakeWorker(events)
    });

    await assert.rejects(loader.load(target.id, target.generation), /did not declare capability command/u);
    assert.deepEqual(events, ["activation.dispose", "worker.closeAll"]);
});

test("Extension loader keeps internal Worker retirement active without granting lifecycle capability", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const target = await harness.writeGeneration({ capabilities: ["worker"] });
    const events: string[] = [];
    const loader = new ExtensionLoader({
        importer: async () => ({ activate: () => ({ dispose() {} }) }),
        instances: { list: () => [] } as never,
        paths: harness.paths,
        workerFactory: () => fakeWorker(events)
    });
    const candidate = await loader.load(target.id, target.generation);
    candidate.activate();
    const lease = candidate.acquire();

    await lease.activation.lifecycle?.onInstanceRetire?.({ instance: "local", reason: "deleted" });

    lease.release();
    assert.deepEqual(events, ["worker.retire:local"]);
    await candidate.retire();
});

test("Extension loader rejects static Web paths escaping the immutable generation", async (t) => {
    const harness = await createHarness();
    t.after(harness.cleanup);
    const target = await harness.writeGeneration({ capabilities: ["web"] });
    const events: string[] = [];
    const loader = new ExtensionLoader({
        importer: async () => ({
            activate: () => ({
                dispose() { events.push("activation.dispose"); },
                web: { directory: "../outside", kind: "static" }
            })
        }),
        instances: { list: () => [] } as never,
        paths: harness.paths,
        workerFactory: () => fakeWorker(events)
    });

    await assert.rejects(loader.load(target.id, target.generation), /stay inside/u);
    assert.deepEqual(events, ["activation.dispose", "worker.closeAll"]);
});
