import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { EXTENSION_API_VERSION, EXTENSION_MANIFEST_SCHEMA_VERSION } from "@portable-devshell/extension";
import { ChannelBase, Endpoint, createExtensionRuntimeTransport, createServerTransport } from "@portable-devshell/shared";
import { createExtensionRuntime } from "../../../src/extension/index.ts";
import { ControlExtensionRouteService, TuiExtensionPageService } from "../../../src/extension/Public.ts";
import { InstanceRegistry } from "../../../src/instance/Registry.ts";
import { ControlRouteRegistry } from "../../../src/server/Route.ts";
import { ControlTransportServer } from "../../../src/server/transport/endpoint/Server.ts";
import type { ControlAcceptedChannel } from "../../../src/server/transport/channel/Listener.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

class MemoryChannel extends ChannelBase {
    peer!: MemoryChannel;
    async write(data: Uint8Array) {
        assert.equal(this.closed || this.peer.closed, false);
        const copy = Uint8Array.from(data);
        queueMicrotask(() => this.peer.emitData(copy));
    }
    close(error?: Error) {
        if (this.closed) return;
        this.finish(error);
        this.peer.close(error);
    }
}

test("production Extension runtime publishes atomic RPC state while old generation leases drain", { timeout: 120_000 }, async (t) => {
    const root = await createTestTempDirectory("extension-manager-memory");
    const runtime = createExtensionRuntime({
        instances: new InstanceRegistry([]),
        instanceRuntime: () => { throw new Error("No Instance is used by this extension."); },
        readToolCalls: async () => [],
        pathOptions: { homeDirectory: root, dataHome: root, runtimeRoot: join(root, "runtime") },
    });
    let releaseOld = () => {};
    let subscribers = 0;
    const onChange = runtime.changes.onChange.bind(runtime.changes);
    t.mock.method(runtime.changes, "onChange", (listener: Parameters<typeof onChange>[0]) => {
        subscribers++;
        const off = onChange(listener);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            subscribers--;
            off();
        };
    });
    const pages = new TuiExtensionPageService(runtime);
    const extensions = new ControlExtensionRouteService(runtime);
    const routes = new ControlRouteRegistry({
        instances: new InstanceRegistry([]),
        extension: runtime.control,
        extensionRoutes: extensions,
        extensionState: {
            changes: runtime.changes,
            snapshot: () => runtime.snapshot(() => ({
                tuiPages: [...pages.list()], tuiSupported: true,
                webApplications: [], webPages: [], webSupported: true,
            })),
        },
        overview: { read: async () => { throw new Error("Overview is not used."); } },
        shutdown() {},
    });
    let accept!: (connection: ControlAcceptedChannel) => void;
    const transport = new ControlTransportServer({
        routes,
        listeners: [{ async start(listener) { accept = listener; }, async close() {} }],
    });
    const local = new MemoryChannel();
    const remoteChannel = new MemoryChannel();
    local.peer = remoteChannel;
    remoteChannel.peer = local;
    const endpoint = new Endpoint({ connectChannel: async () => {
        accept({ channel: remoteChannel, admission: { allowedPeers: ["cli"], subject: { id: "local-owner", kind: "local-owner" } } });
        return local;
    } });
    t.after(async () => {
        releaseOld();
        endpoint.close();
        await transport.close();
        routes.dispose();
        assert.equal(subscribers, 0);
        await runtime.stop();
        await rm(root, { recursive: true, force: true });
    });
    await runtime.start();
    await transport.start();
    await createServerTransport(endpoint, { clientKind: "cli" }).hello();
    const remote = createExtensionRuntimeTransport(endpoint);
    assert.deepEqual((await remote.snapshot()).extensions, []);
    const source = join(root, "source");
    await mkdir(source);
    const manifest = {
        activation: "eager", apiVersion: EXTENSION_API_VERSION,
        schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
        capabilities: [], entry: "extension.mjs", hostDependencies: {},
        id: "probe", name: "Probe", version: "1.0.0",
        extensions: { "tui.pages": [{ id: "probe-page", title: "Probe" }] },
    };
    await writeFile(join(source, "devshell-extension.json"), JSON.stringify(manifest));
    await writeFile(join(source, "extension.mjs"), `
        export function activate(context) {
            context.register({ id: "tui.pages" }, "probe-page", async () => ({ items: [] }));
        }
    `);
    await remote.install(source);
    const old = await runtime.acquireRegistration("tui.pages", "probe-page");
    releaseOld = () => old.lease.release();
    const before = await remote.snapshot();
    const stream = await remote.subscribe(before.revision + 1);
    t.after(() => stream.close());
    await writeFile(join(source, "extension.mjs"), `
        export function activate(context) {
            context.register({ id: "tui.pages" }, "probe-page", async () => ({ items: [], title: "replacement" }));
        }
    `);
    await remote.install(source);
    const updated = await remote.snapshot();
    assert.notEqual(updated.extensions[0]?.activeGeneration, old.lease.generation);
    assert.equal(updated.revision, before.revision + 1);
    assert.equal(updated.revision, runtime.changes.revision);
    assert.deepEqual(await stream.next(), { kind: "event", event: { extensionIds: ["probe"], revision: updated.revision } });
    assert.deepEqual((await remote.list())[0]?.retired.map(entry => entry.inFlight), [1]);
    assert.deepEqual(await Reflect.apply(old.registration.binding as (...args: unknown[]) => unknown,
        undefined, [{ kind: "read" }, { requestId: "old", localOwner: true, signal: new AbortController().signal }]), { items: [] });
    old.lease.release();
    await remote.disable("probe");
    const disabled = await remote.snapshot();
    assert.equal(disabled.extensions[0]?.enabled, false);
    assert.deepEqual(disabled.tuiPages, []);
    assert.deepEqual(await stream.next(), { kind: "event", event: { extensionIds: ["probe"], revision: disabled.revision } });
    stream.close();
    const revision = disabled.revision;
    await remote.snapshot();
    assert.equal(runtime.changes.revision, revision, "reads do not produce duplicate revisions");
    // Lazy enable/disable crosses the real default retention without starting
    // a new sandbox for every entry. All revisions still come from Host writes.
    manifest.activation = "lazy";
    await writeFile(join(source, "devshell-extension.json"), JSON.stringify(manifest));
    await remote.install(source);
    for (let index = 0; index < 65; index++) {
        await remote.enable("probe");
        await remote.disable("probe");
    }
    const latest = await remote.snapshot();
    const stale = await remote.subscribe(before.revision + 1);
    const gap = await stale.next();
    assert.equal(gap.kind, "gap");
    if (gap.kind === "gap") {
        assert.equal(gap.gap.fromSeq, before.revision + 1);
        assert.equal(gap.gap.lastSeq, latest.revision);
        assert.equal(gap.gap.nextSeq, latest.revision - 127);
    }
    stale.close();
    const final = await remote.subscribe(latest.revision + 1);
    assert.equal(subscribers, 1, "route rebuilds and cancelled streams do not retain subscriptions");
    const closed = final.next();
    endpoint.close();
    await transport.close();
    assert.equal((await closed).kind, "closed");
    assert.equal(subscribers, 0);
});
