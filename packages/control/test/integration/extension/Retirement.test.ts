import assert from "node:assert/strict";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { EXTENSION_API_VERSION, EXTENSION_MANIFEST_SCHEMA_VERSION } from "@portable-devshell/extension";
import { asInstanceName, createToolCallRuntime, type ControlPortContext, type InstanceRuntimeTransport, type MessageStream } from "@portable-devshell/shared";

import { ExtensionInstanceObserveCapabilityControl } from "../../../src/extension/api/cap/instance/index.ts";
import { ExtensionWorkerCapabilityControl } from "../../../src/extension/api/cap/worker/index.ts";
import { ControlExtensionRouteService } from "../../../src/extension/api/point/control/Dispatch.ts";
import { McpExtensionService } from "../../../src/extension/api/point/mcp/index.ts";
import { ExtensionLoader } from "../../../src/extension/discovery/Loader.ts";
import { ExtensionHost } from "../../../src/extension/host/index.ts";
import { ExtensionInstallService } from "../../../src/extension/install/index.ts";
import { createControlExtensionPointRegistry } from "../../../src/extension/registration/Points.ts";
import { ExtensionPathLayout } from "../../../src/extension/state/Layout.ts";
import { ExtensionRegistryStore } from "../../../src/extension/state/Store.ts";
import { ExtensionChangeHub } from "../../../src/extension/manager/Change.ts";
import { InstanceRegistry } from "../../../src/instance/Registry.ts";
import { createTestInstance } from "../../support/ControlFixtures.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { deferred } from "./Round3Harness.ts";

// Real Instance admission and ToolCall runtime, with an instrumented Worker
// boundary: session IDs and routed payloads make cross-Instance leaks observable.
function worker(name: string, onCall?: (name: string, input: unknown) => Promise<void>) {
    const opened: string[] = [];
    const released: string[] = [];
    const releaseAttempts: string[] = [];
    let release: () => Promise<void> = async () => {};
    const runtime = createToolCallRuntime({ resolveTarget: () => ({
        dispatch: async (request) => {
            await onCall?.(name, request.value.payload);
            return { instance: name, input: request.value.payload };
        },
    }) });
    const instance = createTestInstance({
        supervision: { handshake: {
            homeDirectory: `/home/${name}`,
            platform: { arch: "x86_64", os: "linux" },
        } },
    } as never, {
        config: { enabled: true, name, provider: "local" } as never,
        state: {
            toolCalls: runtime,
            tools: {
                async openSession(workspace: string, id: string) {
                    opened.push(id);
                    return { workspace };
                },
                async releaseSession(id: string) {
                    releaseAttempts.push(id);
                    await release();
                    released.push(id);
                },
                listTools: () => [{ name: "file_read", description: "Read", inputSchema: { type: "object" } }],
            },
        } as never,
    });
    return { instance, opened, released, releaseAttempts, runtime,
        setRelease(fn: () => Promise<void>) { release = fn; },
    };
}

async function harness(t: test.TestContext, runtime?: InstanceRuntimeTransport, onCall?: (name: string, input: unknown) => Promise<void>) {
    const root = await createTestTempDirectory("extension-retirement");
    const alpha = worker("alpha", onCall);
    const beta = worker("beta", onCall);
    const instances = new InstanceRegistry([alpha.instance, beta.instance]);
    const paths = new ExtensionPathLayout({ dataHome: join(root, "data"), homeDirectory: join(root, "home"), runtimeRoot: join(root, "runtime") });
    const host = new ExtensionHost({
        changeHub: new ExtensionChangeHub(),
        registry: new ExtensionRegistryStore(paths.registryFile),
        loader: new ExtensionLoader({
            instances, paths, points: createControlExtensionPointRegistry(),
            readToolCalls: async () => [],
            instanceRuntime: () => { assert.ok(runtime); return runtime; },
            workerExecuteFactory: ({ allowed, extensionId }) => new ExtensionWorkerCapabilityControl({ allowed, extensionId, instances, recording: "host" }),
            instanceFactory: ({ observeAllowed, extensionId }) => ({
                manage: {} as never,
                observe: new ExtensionInstanceObserveCapabilityControl({
                    allowed: observeAllowed, extensionId, listConfigured: () => [],
                    process: () => { throw new Error("unused process access"); },
                    runtime: () => { assert.ok(runtime); return runtime; },
                }),
            }),
        }),
    });
    t.after(async () => {
        await host.stop();
        alpha.runtime.close();
        beta.runtime.close();
        await rm(root, { recursive: true, force: true });
    });
    await host.start();
    return { alpha, beta, host, paths, root, installer: new ExtensionInstallService({ host, paths }) };
}

async function source(root: string, version: string, capabilities: string[], extensions: object, body: string) {
    const directory = join(root, `source-${version}`);
    await mkdir(directory);
    await writeFile(join(directory, "devshell-extension.json"), JSON.stringify({
        id: "probe", name: "Probe", version, activation: "eager",
        apiVersion: EXTENSION_API_VERSION, schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
        entry: "extension.mjs", capabilities, extensions,
    }));
    await writeFile(join(directory, "extension.mjs"), body);
    return directory;
}

test("install replacement retires both Instance worker sessions and removes its MCP catalog on disable", { timeout: 10_000 }, async (t) => {
    const h = await harness(t);
    const mcp = new McpExtensionService(h.host);
    const body = `export async function activate(context) {
        const sessions = {};
        for (const name of ['alpha', 'beta']) sessions[name] = await context.capabilities.workerExecute.openSession({ instance: name, workspace: '/' + name });
        context.register({ id: 'mcp.tools' }, 'probe_read', async (input, invocation) => ({
            structuredContent: { version: context.version, result: await sessions[invocation.instance].callTool('file_read', input) }
        }));
    }`;
    const declarations = { "mcp.tools": [{ id: "probe_read", description: "Read through the selected Instance", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] };
    const first = await h.installer.install(await source(h.root, "1.0.0", ["worker.execute"], declarations, body));
    const invoke = (instance: string) => mcp.callTool("probe_read", { path: instance }, { callId: `call-${instance}`, instance, workspace: `/${instance}` });
    assert.deepEqual((await invoke("alpha")).structuredContent, { version: "1.0.0", result: { instance: "alpha", input: { path: "alpha" } } });
    assert.deepEqual((await invoke("beta")).structuredContent, { version: "1.0.0", result: { instance: "beta", input: { path: "beta" } } });
    const previous = [h.alpha.opened.at(-1)!, h.beta.opened.at(-1)!];
    const replacement = await h.installer.install(await source(h.root, "2.0.0", ["worker.execute"], declarations, body));
    await h.host.waitForDrain("probe");
    assert.notEqual(replacement.activeGeneration, first.activeGeneration);
    // Install also validates disposable candidate runtimes. Every session
    // except the selected runtime's session must have been released.
    assert.deepEqual([...h.alpha.released].sort(), h.alpha.opened.slice(0, -1).sort());
    assert.deepEqual([...h.beta.released].sort(), h.beta.opened.slice(0, -1).sort());
    assert.ok(h.alpha.released.includes(previous[0]!));
    assert.ok(h.beta.released.includes(previous[1]!));
    assert.notEqual(h.alpha.opened.at(-1), previous[0]);
    assert.notEqual(h.beta.opened.at(-1), previous[1]);
    assert.equal(new Set([...h.alpha.opened, ...h.beta.opened]).size, h.alpha.opened.length + h.beta.opened.length);
    assert.deepEqual((await invoke("beta")).structuredContent, { version: "2.0.0", result: { instance: "beta", input: { path: "beta" } } });
    await h.host.disable("probe");
    await h.host.waitForDrain("probe");
    assert.deepEqual(h.host.listDeclarations("mcp.tools"), []);
    await assert.rejects(invoke("alpha"), /No Extension registration for mcp\.tools\/probe_read/u);
    assert.deepEqual([...h.alpha.released].sort(), [...h.alpha.opened].sort());
    assert.deepEqual([...h.beta.released].sort(), [...h.beta.opened].sort());
    assert.equal(h.alpha.instance.lifecycle.active, true);
    assert.equal(h.beta.instance.lifecycle.active, true);
});

const workerDeclarations = { "mcp.tools": [{
    id: "probe_read", description: "Read through the selected Instance",
    inputSchema: { type: "object" }, outputSchema: { type: "object" },
}] };
const workerBody = `export async function activate(context) {
    const sessions = {};
    for (const name of ['alpha', 'beta']) sessions[name] = await context.capabilities.workerExecute.openSession({ instance: name, workspace: '/' + name });
    context.register({ id: 'mcp.tools' }, 'probe_read', async (input, invocation) => ({
        structuredContent: await sessions[invocation.instance].callTool('file_read', input)
    }));
}`;

test("installed Worker release failing once is retried by Instance retirement and reload stays usable", { timeout: 10_000 }, async (t) => {
    const h = await harness(t);
    await h.installer.install(await source(h.root, "1.0.0", ["worker.execute"], workerDeclarations, workerBody));
    const alphaSession = h.alpha.opened.at(-1)!;
    const betaSession = h.beta.opened.at(-1)!;
    const mcp = new McpExtensionService(h.host);
    const invoke = (instance: string) => mcp.callTool("probe_read", { path: instance }, {
        callId: `retry-${instance}`, instance, workspace: `/${instance}`,
    });
    const failure = new Error("transient Worker release failure");
    h.alpha.setRelease(async () => {
        h.alpha.setRelease(async () => {});
        throw failure;
    });
    await assert.rejects(h.host.retireInstanceGeneration("alpha"), {
        message: "Extensions failed to retire host-managed resources for instance alpha.",
        errors: [new Error("Extension probe failed to retire host-managed resources for instance alpha.", { cause: failure })],
    });
    assert.equal(h.alpha.released.includes(alphaSession), false);
    await assert.rejects(invoke("alpha"), /closed/u);
    assert.deepEqual((await invoke("beta")).structuredContent, { instance: "beta", input: { path: "beta" } });
    await h.host.retireInstanceGeneration("alpha");
    assert.equal(h.alpha.releaseAttempts.filter((id) => id === alphaSession).length, 2);
    assert.equal(h.alpha.released.filter((id) => id === alphaSession).length, 1);
    assert.equal(h.beta.released.includes(betaSession), false);
    await h.host.reload("probe");
    await h.host.waitForDrain("probe");
    assert.equal(h.alpha.released.filter((id) => id === alphaSession).length, 1);
    assert.equal(h.beta.released.filter((id) => id === betaSession).length, 1);
    assert.deepEqual((await invoke("alpha")).structuredContent, { instance: "alpha", input: { path: "alpha" } });
    assert.equal(h.alpha.instance.lifecycle.active, true);
    assert.equal(h.beta.instance.lifecycle.active, true);
});

test("unload retains failed Worker resources across drains and permits a usable replacement", { timeout: 10_000 }, async (t) => {
    const h = await harness(t);
    const installed = await h.installer.install(await source(h.root, "1.0.0", ["worker.execute"], workerDeclarations, workerBody));
    const oldAlpha = h.alpha.opened.at(-1)!;
    const oldBeta = h.beta.opened.at(-1)!;
    h.alpha.setRelease(async () => { throw new Error("Worker release unavailable"); });
    // Restore the external boundary even if an assertion fails so host.stop can drain.
    t.after(() => h.alpha.setRelease(async () => {}));
    await h.host.disable("probe");
    await assert.rejects(h.host.waitForDrain("probe"), /failed to drain cleanly/u);
    await assert.rejects(h.host.waitForDrain("probe"), /failed to drain cleanly/u);
    assert.deepEqual((await h.host.list())[0]!.retired, [{
        generation: installed.activeGeneration, inFlight: 0, state: "dispose-failed",
    }]);
    await assert.rejects(h.host.forget("probe"), /still has active or draining generations/u);
    assert.equal(h.alpha.released.includes(oldAlpha), false);
    assert.equal(h.beta.released.filter((id) => id === oldBeta).length, 1);
    await h.host.enable("probe");
    const newAlpha = h.alpha.opened.at(-1)!;
    assert.notEqual(newAlpha, oldAlpha);
    const mcp = new McpExtensionService(h.host);
    assert.deepEqual((await mcp.callTool("probe_read", {}, {
        callId: "replacement", instance: "alpha", workspace: "/alpha",
    })).structuredContent, { instance: "alpha", input: {} });
    h.alpha.setRelease(async () => {});
    await h.host.waitForDrain("probe");
    assert.deepEqual((await h.host.list())[0]!.retired, []);
    assert.equal(h.alpha.released.filter((id) => id === oldAlpha).length, 1);
    assert.equal(h.alpha.released.includes(newAlpha), false);
    await h.host.disable("probe");
    await h.host.waitForDrain("probe");
    await h.host.forget("probe");
    assert.deepEqual(await h.host.list(), []);
    assert.deepEqual([...h.alpha.released].sort(), [...h.alpha.opened].sort());
    assert.deepEqual([...h.beta.released].sort(), [...h.beta.opened].sort());
});

test("retiring an installed sandbox stream releases its subscription while a send is blocked", { timeout: 10_000 }, async (t) => {
    let markSending!: () => void;
    const sending = new Promise<void>((resolve) => { markSending = resolve; });
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let markClosed!: () => void;
    const subscriptionClosed = new Promise<void>((resolve) => { markClosed = resolve; });
    t.after(() => unblock());
    let closes = 0;
    const runtime: InstanceRuntimeTransport = {
        acquireReference: async () => ({}), releaseReference: async () => {}, appendEvent: async () => {},
        readEvents: async () => ({ kind: "events", events: [], lastSeq: 0 }),
        subscribeEvents: async () => {
            let served = false;
            return {
                close() { closes += 1; markClosed(); },
                async next() {
                    if (served) {
                        await subscriptionClosed;
                        return { kind: "closed" as const };
                    }
                    served = true;
                    return { kind: "event" as const, event: { at: "2026-10-20T00:00:00Z", instanceName: asInstanceName("alpha"), seq: 1, type: "instance.started" } };
                },
            };
        },
    };
    const h = await harness(t, runtime);
    const installed = await h.installer.install(await source(h.root, "1.0.0", ["instance.observe"], {
        "control.streams": [{ id: "probe-events", module: "probe", operation: "subscribe", scope: "instance" }],
    }, `export function activate(context) {
        context.register({ id: 'control.streams' }, 'probe-events', async (stream, request, invocation) => {
            await context.capabilities.instanceObserve.watchEvents(invocation.destination, {
                fromSeq: 1, signal: invocation.signal, onEvent: async (event) => await stream.send({ name: 'event', payload: event })
            });
        });
    }`));
    const routes = new ControlExtensionRouteService(h.host);
    t.after(() => routes.retireInstance("alpha"));
    let streamCloses = 0;
    await routes.modules("instance")[0]!.streams![0]!.handle({
        send: async () => { markSending(); await blocked; },
        close: async () => { streamCloses += 1; },
        cancel: async () => { assert.fail("retirement must close the stream"); },
    } as unknown as MessageStream, { id: "blocked", name: "subscribe" }, {
        host: "alpha", peer: "cli", requestId: "blocked", signal: new AbortController().signal,
    } as ControlPortContext);
    await sending;
    await h.host.disable("probe");
    await subscriptionClosed;
    await h.host.waitForDrain("probe");
    await routes.retireInstance("alpha");
    assert.equal(closes, 2, "abort and watch cleanup both close the underlying subscription");
    assert.equal(streamCloses, 1);
    assert.deepEqual(h.host.listDeclarations("control.streams"), []);
    await assert.rejects(stat(h.paths.runtimeDirectory("probe", installed.selectedGeneration!)), { code: "ENOENT" });
    unblock();
});

test("same-hash sandbox reload pins a failing lifecycle callback and retires only its old worker sessions", { timeout: 10_000 }, async (t) => {
    const entered = deferred();
    const finish = deferred();
    t.after(() => finish.resolve());
    const h = await harness(t, undefined, async (name, input) => {
        if ((input as { retirement?: boolean }).retirement === true) {
            assert.equal(name, "alpha");
            entered.resolve();
            await finish.promise;
        }
    });
    const body = `const sessions = {};
export async function activate(context) {
    for (const name of ['alpha', 'beta']) sessions[name] = await context.capabilities.workerExecute.openSession({ instance: name, workspace: '/' + name });
    context.register({ id: 'mcp.tools' }, 'probe_read', async (input, invocation) => ({
        structuredContent: await sessions[invocation.instance].callTool('file_read', input)
    }));
}
export async function instanceGenerationRetired(event) {
    await sessions[event.instance].callTool('file_read', { retirement: true });
    throw new Error('notification failed after worker barrier');
}`;
    await h.installer.install(await source(h.root, "1.0.0", ["worker.execute"], {
        "mcp.tools": [{ id: "probe_read", description: "Read", inputSchema: { type: "object" }, outputSchema: { type: "object" } }],
    }, body));
    const oldAlpha = h.alpha.opened.at(-1)!;
    const oldBeta = h.beta.opened.at(-1)!;
    const retirement = h.host.retireInstanceGeneration("alpha");
    const rejected = assert.rejects(retirement, /failed to handle Instance generation retirement/u);
    try {
        await entered.promise;
        await h.host.reload("probe");
        const selected = await h.host.readPublicState((state) => state);
        assert.equal((await h.host.list())[0]!.retired[0]!.inFlight, 1);
        assert.equal(h.alpha.released.includes(oldAlpha), false);
        assert.equal(h.beta.released.includes(oldBeta), false);
        const newAlpha = h.alpha.opened.at(-1)!;
        const newBeta = h.beta.opened.at(-1)!;
        assert.notEqual(newAlpha, oldAlpha);
        assert.notEqual(newBeta, oldBeta);
        const mcp = new McpExtensionService(h.host);
        const invoke = async (instance: string) => await mcp.callTool("probe_read", { path: instance }, {
            callId: `fresh-${instance}`, instance, workspace: `/${instance}`,
        });
        assert.deepEqual((await invoke("beta")).structuredContent, { instance: "beta", input: { path: "beta" } });
        finish.resolve();
        await rejected;
        await h.host.waitForDrain("probe");
        assert.equal(h.alpha.released.includes(oldAlpha), true);
        assert.equal(h.beta.released.includes(oldBeta), true);
        assert.equal(h.alpha.released.includes(newAlpha), false);
        assert.equal(h.beta.released.includes(newBeta), false);
        assert.deepEqual((await invoke("alpha")).structuredContent, { instance: "alpha", input: { path: "alpha" } });
        assert.deepEqual((await invoke("beta")).structuredContent, { instance: "beta", input: { path: "beta" } });
        assert.deepEqual(await h.host.readPublicState((state) => state), selected);
        assert.equal(h.alpha.instance.lifecycle.active, true);
        assert.equal(h.beta.instance.lifecycle.active, true);
    } finally {
        finish.resolve();
        await rejected;
    }
});
