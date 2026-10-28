import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { EXTENSION_API_VERSION, EXTENSION_MANIFEST_SCHEMA_VERSION } from "@portable-devshell/extension";
import {
    Endpoint, LocalChannel, createDefaultControlConfig,
    createExtensionRuntimeTransport, createServerTransport,
} from "@portable-devshell/shared";
import { Control } from "../../../src/Control.ts";
import { ControlFactory } from "../../../src/Factory.ts";
import { ControlConfigStore } from "../../../src/config/store/index.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

test("production Control Extension manager shares atomic snapshots and revisioned subscriptions across updates and restart", { timeout: 120_000 }, async (t) => {
    const root = await createTestTempDirectory("extension-manager-composition");
    // Factory uses the production default Extension paths; isolate all of them.
    const environment = {
        PORTABLE_DEVSHELL_HOME: join(root, "home"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_RUNTIME_DIR: root,
    };
    const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    Object.assign(process.env, environment);
    const store = new ControlConfigStore();
    const config = createDefaultControlConfig();
    config.mcp.enabled = false;
    config.web.enabled = false;
    const endpoints: Endpoint[] = [];
    const control = new Control({
        configStore: store, homeDirectory: root, xdgRuntimeDir: root,
        factory: new ControlFactory({ builtinExtensionSources: [] }),
    });
    t.after(async () => {
        for (const endpoint of endpoints) endpoint.close();
        try { await control.stop(); }
        finally {
            for (const key of Object.keys(environment)) {
                if (previous[key] === undefined) delete process.env[key];
                else process.env[key] = previous[key];
            }
            await rm(root, { recursive: true, force: true });
        }
    });
    await store.write(config, root);
    async function connect() {
        const endpoint = new Endpoint({ connectChannel: signal => LocalChannel.connect(control.socketPath, { signal }) });
        endpoints.push(endpoint);
        const server = createServerTransport(endpoint, { clientKind: "cli" });
        await server.hello();
        return { remote: createExtensionRuntimeTransport(endpoint), server };
    }
    async function source(version: string) {
        const directory = join(root, `source-${version}`);
        await mkdir(directory);
        await writeFile(join(directory, "devshell-extension.json"), JSON.stringify({
            activation: "eager", apiVersion: EXTENSION_API_VERSION,
            schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
            capabilities: [], entry: "extension.mjs", hostDependencies: {},
            id: "manager-probe", name: "Manager probe", version,
            extensions: { "tui.pages": [{ id: "manager-page", title: version }] },
        }));
        await writeFile(join(directory, "extension.mjs"), `
            export function activate(context) {
                context.register({ id: "tui.pages" }, "manager-page", async () => ({ items: [] }));
            }
        `);
        return directory;
    }
    await control.start();
    const { remote, server } = await connect();
    const status = await server.status();
    assert.equal("ready" in status && status.ready, true);
    const empty = await remote.snapshot();
    assert.deepEqual(empty.extensions, []);
    const first = await remote.install(await source("1.0.0"));
    assert.equal(first.state, "active");
    const before = await remote.snapshot();
    assert.equal(before.extensions[0]?.activeGeneration, first.activeGeneration);
    assert.deepEqual(before.tuiPages, [{ extensionId: "manager-probe", id: "manager-page", title: "1.0.0" }]);
    assert.ok(before.revision > empty.revision);
    assert.equal("retired" in before.extensions[0]!, false);
    const stream = await remote.subscribe(before.revision + 1);
    t.after(() => stream.close());
    const next = stream.next();
    const second = await remote.install(await source("2.0.0"));
    const updated = await remote.snapshot();
    assert.notEqual(second.activeGeneration, first.activeGeneration);
    assert.equal(updated.extensions[0]?.activeGeneration, second.activeGeneration);
    assert.equal(updated.tuiPages[0]?.title, "2.0.0");
    assert.deepEqual(await next, { kind: "event", event: { extensionIds: ["manager-probe"], revision: updated.revision } });
    assert.equal(updated.revision, before.revision + 1);
    await remote.disable("manager-probe");
    const disabled = await remote.snapshot();
    assert.equal(disabled.extensions[0]?.enabled, false);
    assert.deepEqual(disabled.tuiPages, []);
    assert.deepEqual(await stream.next(), { kind: "event", event: { extensionIds: ["manager-probe"], revision: updated.revision + 1 } });
    stream.close();

    // Exercise production retention without replacing/injecting a test hub.
    for (let index = 0; index < 65; index++) {
        await remote.enable("manager-probe");
        await remote.disable("manager-probe");
    }
    const latest = await remote.snapshot();
    const stale = await remote.subscribe(before.revision + 1);
    t.after(() => stale.close());
    const gap = await stale.next();
    assert.equal(gap.kind, "gap");
    if (gap.kind === "gap") {
        assert.equal(gap.gap.fromSeq, before.revision + 1);
        assert.equal(gap.gap.lastSeq, latest.revision);
        assert.equal(gap.gap.nextSeq, latest.revision - 127);
    }
    stale.close();
    // Keep one subscriber open during stop to exercise transport cleanup.
    const stopping = await remote.subscribe(latest.revision + 1);
    const stopped = stopping.next();
    await control.stop();
    assert.equal((await stopped).kind, "closed");
    await control.start();
    const restarted = await connect();
    const restartedStatus = await restarted.server.status();
    assert.equal("ready" in restartedStatus && restartedStatus.ready, true);
    const restored = await restarted.remote.snapshot();
    assert.equal(restored.extensions[0]?.selectedGeneration, second.selectedGeneration);
    assert.equal(restored.extensions[0]?.enabled, false);
    const resumed = await restarted.remote.subscribe(restored.revision + 1);
    t.after(() => resumed.close());
    await restarted.remote.enable("manager-probe");
    const enabled = await restarted.remote.snapshot();
    assert.equal(enabled.extensions[0]?.state, "active");
    assert.deepEqual(await resumed.next(), { kind: "event", event: { extensionIds: ["manager-probe"], revision: enabled.revision } });
    assert.equal(enabled.revision, restored.revision + 1);
});
