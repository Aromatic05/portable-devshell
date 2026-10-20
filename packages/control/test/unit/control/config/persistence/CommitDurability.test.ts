import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ControlPathHome, createDefaultControlConfig, normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import { ControlConfigStore } from "../../../../../src/config/store/index.ts";
import { createTestTempDirectory } from "../../../../../../../test/TestTempDirectory.ts";
import { runPersistenceProcess } from "./CrashProcess.ts";

const storeUrl = new URL("../../../../../src/config/store/index.ts", import.meta.url).href;
const engineUrl = new URL("../../../../../src/config/engine/index.ts", import.meta.url).href;
const hubUrl = new URL("../../../../../src/config/change/Config.ts", import.meta.url).href;

async function generation(t: test.TestContext) {
    const home = await createTestTempDirectory("config-commit-durability");
    t.after(() => rm(home, { force: true, recursive: true }));
    const paths = new ControlPathHome(home);
    const original = createDefaultControlConfig();
    original.web.listenPort = 17892;
    original.instances = ["alpha-local", "stale-local"].map((name) =>
        normalizeConfigInstanceDraft({ name, provider: "local" }),
    );
    await new ControlConfigStore().write(original, home);
    const foreign = join(paths.instancesDir, "部署_notes.toml");
    await writeFile(foreign, "operator-owned unrecognized document\n");
    const files = [paths.configFile, ...original.instances.map((instance) => paths.instanceConfigFile(instance.name)), foreign];
    const bytes = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const next = structuredClone(original);
    next.web.listenPort = 17893;
    next.instances = ["alpha-local", "added-local"].map((name) =>
        normalizeConfigInstanceDraft({ name, provider: "local", enabled: false }),
    );
    return {
        home, original, next, files, bytes, foreign,
        configFile: paths.configFile,
        controlDir: paths.controlHomeDir,
        marker: join(paths.controlHomeDir, ".config-transaction"),
    };
}

// Patch only the disposable process. The real unlink succeeds before its
// final directory fsync fails; earlier directory syncs must not hit this fault.
const finalSyncFault = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const { home, original, next, controlDir, marker, configFile, foreign } = JSON.parse(process.argv[1]);
    const open = fs.open;
    const remove = fs.rm;
    const failure = Object.assign(new Error('injected final control directory fsync EIO'), { code: 'EIO' });
    let markerRemoved = false;
    let hits = 0;
    fs.rm = async (path, options) => {
        await remove(path, options);
        if (path === marker) markerRemoved = true;
    };
    fs.open = async (...args) => {
        const handle = await open(...args);
        if (args[0] === controlDir && args[1] === 'r') {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => {
                if (markerRemoved && hits === 0) {
                    hits++;
                    throw failure;
                }
                await sync();
            };
        }
        return handle;
    };
    syncBuiltinESMExports();
    const warnings = [];
    console.warn = (...args) => warnings.push(args);
    const { ControlConfigStore, ControlConfigCommittedDurabilityError } = await import(${JSON.stringify(storeUrl)});
    const { ConfigEngine } = await import(${JSON.stringify(engineUrl)});
`;

test("final commit fsync EIO publishes ConfigEngine memory, runtime and change notification with a durability warning", async (t) => {
    const fixture = await generation(t);
    assert.equal(runPersistenceProcess(finalSyncFault + `
        const { ConfigChangeHub } = await import(${JSON.stringify(hubUrl)});
        const hub = new ConfigChangeHub();
        let current = original;
        let runtimeCalls = 0;
        const engine = new ConfigEngine({
            configStore: new ControlConfigStore(), homeDirectory: home, changeHub: hub,
            getConfig: () => current, setConfig: (value) => { current = value; },
            runtimeApply: { async apply(previous, value, changes) {
                runtimeCalls++;
                assert.equal(previous.web.listenPort, 17892);
                assert.equal(value.web.listenPort, 17893);
                assert.equal(current.web.listenPort, 17893);
                assert.deepEqual(changes, { instanceAuth: false, mcp: false, web: true });
                assert.match(await fs.readFile(configFile, 'utf8'), /listenPort = 17893/);
                return true;
            } },
        });
        await engine.commit(original, next, [], { instanceAuth: false, mcp: false, web: true }, false);
        assert.equal(hits, 1);
        assert.equal(engine.current.web.listenPort, 17893);
        assert.deepEqual(engine.current.instances.map(({ name, enabled }) => [name, enabled]), [['alpha-local', false], ['added-local', false]]);
        assert.equal(runtimeCalls, 1);
        assert.equal(hub.revision, 1);
        const diagnostics = warnings.filter((args) => args[1] instanceof ControlConfigCommittedDurabilityError);
        assert.equal(diagnostics.length, 1);
        assert.deepEqual(diagnostics[0][1].errors, [failure]);
        assert.match(diagnostics[0][1].message, /durability.*not.*confirmed/i);
        await assert.rejects(fs.readFile(marker), { code: 'ENOENT' });
        assert.equal((await new ControlConfigStore().readOrCreate(home)).web.listenPort, 17893);
        assert.equal(await fs.readFile(foreign, 'utf8'), ${JSON.stringify("operator-owned unrecognized document\n")});
        process.stdout.write('published');
    `, fixture), "published");

    const journals = (await readdir(fixture.controlDir)).filter((name) => name.startsWith(".config-transaction-"));
    assert.equal(journals.length, 1);
    const backup = join(fixture.controlDir, journals[0]!, "backup");
    assert.equal(await readFile(join(backup, "config.toml"), "utf8"), fixture.bytes[0]);
    assert.equal(await readFile(join(backup, "instances", "部署_notes.toml"), "utf8"), fixture.bytes[3]);
    t.mock.method(console, "warn", () => undefined);
    assert.equal((await new ControlConfigStore().readOrCreate(fixture.home)).web.listenPort, 17893);
});

test("marker removal EIO after real unlink publishes ConfigEngine memory and runtime while retaining rollback data", async (t) => {
    const fixture = await generation(t);
    assert.equal(runPersistenceProcess(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, original, next, marker, configFile } = JSON.parse(process.argv[1]);
        const remove = fs.rm;
        const failure = Object.assign(new Error('injected marker removal after-effect EIO'), { code: 'EIO' });
        let hits = 0;
        fs.rm = async (path, options) => {
            await remove(path, options);
            if (path === marker) { hits++; throw failure; }
        };
        syncBuiltinESMExports();
        const warnings = [];
        console.warn = (...args) => warnings.push(args);
        const { ControlConfigStore, ControlConfigCommittedDurabilityError } = await import(${JSON.stringify(storeUrl)});
        const { ConfigEngine } = await import(${JSON.stringify(engineUrl)});
        const { ConfigChangeHub } = await import(${JSON.stringify(hubUrl)});
        const hub = new ConfigChangeHub();
        let current = original;
        let runtimeCalls = 0;
        const engine = new ConfigEngine({
            configStore: new ControlConfigStore(), homeDirectory: home, changeHub: hub,
            getConfig: () => current, setConfig: (value) => { current = value; },
            runtimeApply: { async apply(previous, value) {
                runtimeCalls++;
                assert.equal(previous.web.listenPort, 17892);
                assert.equal(value.web.listenPort, 17893);
                assert.equal(current.web.listenPort, 17893);
                assert.match(await fs.readFile(configFile, 'utf8'), /listenPort = 17893/);
                return true;
            } },
        });
        await engine.commit(original, next, [], { instanceAuth: false, mcp: false, web: true }, false);
        assert.equal(hits, 1);
        assert.equal(engine.current.web.listenPort, 17893);
        assert.equal(runtimeCalls, 1);
        assert.equal(hub.revision, 1);
        const diagnostics = warnings.filter((args) => args[1] instanceof ControlConfigCommittedDurabilityError);
        assert.equal(diagnostics.length, 1);
        assert.deepEqual(diagnostics[0][1].errors, [failure]);
        assert.match(diagnostics[0][1].message, /durability.*not.*confirmed/i);
        await assert.rejects(fs.readFile(marker), { code: 'ENOENT' });
        assert.equal((await new ControlConfigStore().readOrCreate(home)).web.listenPort, 17893);
        process.stdout.write('published-after-unlink');
    `, fixture), "published-after-unlink");

    const journals = (await readdir(fixture.controlDir)).filter((name) => name.startsWith(".config-transaction-"));
    assert.equal(journals.length, 1);
    const backup = join(fixture.controlDir, journals[0]!, "backup");
    assert.equal(await readFile(join(backup, "config.toml"), "utf8"), fixture.bytes[0]);
    assert.deepEqual(await Promise.all(["alpha-local.toml", "stale-local.toml", "部署_notes.toml"].map((name) =>
        readFile(join(backup, "instances", name), "utf8"))), fixture.bytes.slice(1));
    assert.equal(await readFile(fixture.foreign, "utf8"), fixture.bytes[3]);
});

test("marker removal and probe failures preserve both diagnostics without guessing a commit", async (t) => {
    const fixture = await generation(t);
    assert.equal(runPersistenceProcess(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, original, next, marker } = JSON.parse(process.argv[1]);
        const remove = fs.rm;
        const read = fs.readFile;
        const failure = Object.assign(new Error('injected marker removal after-effect EIO'), { code: 'EIO' });
        const probeFailure = Object.assign(new Error('injected marker probe EACCES'), { code: 'EACCES' });
        let unlinkHits = 0;
        let probeHits = 0;
        fs.rm = async (path, options) => {
            await remove(path, options);
            if (path === marker) { unlinkHits++; throw failure; }
        };
        fs.readFile = async (path, ...args) => {
            if (path === marker && unlinkHits > 0) { probeHits++; throw probeFailure; }
            return await read(path, ...args);
        };
        syncBuiltinESMExports();
        console.warn = () => undefined;
        const { ControlConfigStore, ControlConfigCommittedDurabilityError } = await import(${JSON.stringify(storeUrl)});
        const { ConfigEngine } = await import(${JSON.stringify(engineUrl)});
        let current = original;
        let runtimeCalls = 0;
        const engine = new ConfigEngine({
            configStore: new ControlConfigStore(), homeDirectory: home,
            getConfig: () => current, setConfig: (value) => { current = value; },
            runtimeApply: { async apply() { runtimeCalls++; return true; } },
        });
        await assert.rejects(engine.commit(original, next, [], { instanceAuth: false, mcp: false, web: true }, false), (error) => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error instanceof ControlConfigCommittedDurabilityError, false);
            assert.deepEqual(error.errors, [failure, probeFailure]);
            assert.match(error.message, /could not be determined/i);
            return true;
        });
        assert.equal(unlinkHits, 1);
        assert.equal(probeHits, 1);
        assert.equal(engine.current.web.listenPort, 17892);
        assert.equal(runtimeCalls, 0);
        process.stdout.write('uncertain-outcome');
    `, fixture), "uncertain-outcome");
    const journals = (await readdir(fixture.controlDir)).filter((name) => name.startsWith(".config-transaction-"));
    assert.equal(journals.length, 1);
    assert.equal(await readFile(join(fixture.controlDir, journals[0]!, "backup", "config.toml"), "utf8"), fixture.bytes[0]);
});

test("marker removal error with a different transaction ID preserves the marker and reports uncertainty", async (t) => {
    const fixture = await generation(t);
    const foreignId = "00000000-0000-0000-0000-000000000000";
    assert.equal(runPersistenceProcess(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, original, next, marker, foreignId } = JSON.parse(process.argv[1]);
        const remove = fs.rm;
        const failure = Object.assign(new Error('injected marker removal EIO after marker replacement'), { code: 'EIO' });
        let hits = 0;
        fs.rm = async (path, options) => {
            if (path === marker) {
                hits++;
                await fs.writeFile(marker, foreignId);
                throw failure;
            }
            await remove(path, options);
        };
        syncBuiltinESMExports();
        console.warn = () => undefined;
        const { ControlConfigStore, ControlConfigCommittedDurabilityError } = await import(${JSON.stringify(storeUrl)});
        const { ConfigEngine } = await import(${JSON.stringify(engineUrl)});
        let current = original;
        const engine = new ConfigEngine({
            configStore: new ControlConfigStore(), homeDirectory: home,
            getConfig: () => current, setConfig: (value) => { current = value; },
        });
        await assert.rejects(engine.persist(next), (error) => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error instanceof ControlConfigCommittedDurabilityError, false);
            assert.deepEqual(error.errors, [failure]);
            assert.match(error.message, /marker changed/i);
            return true;
        });
        assert.equal(hits, 1);
        assert.equal(engine.current.web.listenPort, 17892);
        assert.equal(await fs.readFile(marker, 'utf8'), foreignId);
        process.stdout.write('different-marker-preserved');
    `, { ...fixture, foreignId }), "different-marker-preserved");
    assert.equal(await readFile(fixture.marker, "utf8"), foreignId);
    const journals = (await readdir(fixture.controlDir)).filter((name) => name.startsWith(".config-transaction-"));
    assert.equal(journals.length, 1);
    assert.equal(await readFile(join(fixture.controlDir, journals[0]!, "backup", "config.toml"), "utf8"), fixture.bytes[0]);
    // Once the conflicting marker is resolved, the retained original journal
    // must still restore the complete old generation without lost user data.
    await writeFile(fixture.marker, journals[0]!.slice(".config-transaction-".length));
    t.mock.method(console, "warn", () => undefined);
    assert.equal((await new ControlConfigStore().readOrCreate(fixture.home)).web.listenPort, 17892);
    assert.deepEqual(await Promise.all(fixture.files.map((file) => readFile(file, "utf8"))), fixture.bytes);
});

test("runtime apply failure after final fsync EIO still restores disk and ConfigEngine memory", async (t) => {
    const fixture = await generation(t);
    assert.equal(runPersistenceProcess(finalSyncFault + `
        const { ConfigChangeHub } = await import(${JSON.stringify(hubUrl)});
        const hub = new ConfigChangeHub();
        const runtimeFailure = new Error('injected runtime apply failure');
        let current = original;
        let runtimeCalls = 0;
        const engine = new ConfigEngine({
            configStore: new ControlConfigStore(), homeDirectory: home, changeHub: hub,
            getConfig: () => current, setConfig: (value) => { current = value; },
            runtimeApply: { async apply() {
                runtimeCalls++;
                assert.equal(current.web.listenPort, 17893);
                throw runtimeFailure;
            } },
        });
        await assert.rejects(engine.commit(original, next, [], { instanceAuth: false, mcp: false, web: true }, false), runtimeFailure);
        assert.equal(hits, 1);
        assert.equal(runtimeCalls, 1);
        assert.equal(engine.current.web.listenPort, 17892);
        assert.equal((await new ControlConfigStore().readOrCreate(home)).web.listenPort, 17892);
        assert.equal(hub.revision, 0);
        assert.equal(warnings.filter((args) => args[1] instanceof ControlConfigCommittedDurabilityError).length, 1);
        process.stdout.write('restored');
    `, fixture), "restored");
    assert.deepEqual(await Promise.all(fixture.files.map((file) => readFile(file, "utf8"))), fixture.bytes);
});

test("final fsync EIO keeps a recoverable journal if a power loss restores the live marker", async (t) => {
    const fixture = await generation(t);
    const id = runPersistenceProcess(finalSyncFault + `
        await assert.rejects(new ControlConfigStore().write(next, home), (error) => {
            assert.ok(error instanceof AggregateError);
            assert.ok(error instanceof ControlConfigCommittedDurabilityError);
            assert.deepEqual(error.errors, [failure]);
            return true;
        });
        assert.equal(hits, 1);
        await assert.rejects(fs.readFile(marker), { code: 'ENOENT' });
        const journals = (await fs.readdir(controlDir)).filter((name) => name.startsWith('.config-transaction-'));
        assert.equal(journals.length, 1);
        process.stdout.write(journals[0].slice('.config-transaction-'.length));
    `, fixture);

    // Model the other allowed crash outcome of an unconfirmed unlink. The
    // committed-intent file alone must never override a recovered live marker.
    await writeFile(fixture.marker, id);
    const recovered = JSON.parse(runPersistenceProcess(`
        const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
        process.stdout.write(JSON.stringify(await new ControlConfigStore().readOrCreate(JSON.parse(process.argv[1]))));
    `, fixture.home));
    assert.equal(recovered.web.listenPort, 17892);
    assert.deepEqual(recovered.instances.map((instance: { name: string }) => instance.name), ["alpha-local", "stale-local"]);
    assert.deepEqual(await Promise.all(fixture.files.map((file) => readFile(file, "utf8"))), fixture.bytes);
    await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
});

test("deferred backup GC confirms marker removal durability before deleting recovery data", async (t) => {
    const fixture = await generation(t);
    assert.equal(runPersistenceProcess(finalSyncFault + `
        await assert.rejects(new ControlConfigStore().write(next, home), AggregateError);
        assert.equal(hits, 1);
        const journals = (await fs.readdir(controlDir)).filter((name) => name.startsWith('.config-transaction-'));
        assert.equal(journals.length, 1);
        const backup = join(controlDir, journals[0]);
        let gcSyncHits = 0;
        fs.open = async (...args) => {
            const handle = await open(...args);
            if (args[0] === controlDir && args[1] === 'r') {
                const sync = handle.sync.bind(handle);
                handle.sync = async () => {
                    if (gcSyncHits === 0) {
                        gcSyncHits++;
                        throw Object.assign(new Error('injected deferred GC fsync EIO'), { code: 'EIO' });
                    }
                    await sync();
                };
            }
            return handle;
        };
        syncBuiltinESMExports();
        await new ControlConfigStore().write(next, home);
        assert.equal(gcSyncHits, 1);
        assert.match(await fs.readFile(join(backup, 'backup', 'config.toml'), 'utf8'), /listenPort = 17892/);
        assert.equal((await new ControlConfigStore().readOrCreate(home)).web.listenPort, 17893);
        assert.equal(warnings.filter((args) => args[0] === 'Control configuration backup cleanup deferred:').length, 1);
        fs.open = open;
        syncBuiltinESMExports();
        await new ControlConfigStore().write(next, home);
        assert.deepEqual((await fs.readdir(controlDir)).filter((name) => name.startsWith('.config-transaction-')), []);
        process.stdout.write('gc-confirmed');
    `, fixture), "gc-confirmed");
    assert.equal(await readFile(fixture.foreign, "utf8"), fixture.bytes[3]);
});

for (const boundary of ["commit-intent-sync", "marker-removal"] as const) {
    test(`${boundary} failure with a live marker does not publish memory or runtime and recovery restores the old generation`, async (t) => {
        const fixture = await generation(t);
        assert.equal(runPersistenceProcess(`
            import assert from 'node:assert/strict';
            import fs from 'node:fs/promises';
            import { join } from 'node:path';
            import { syncBuiltinESMExports } from 'node:module';
            const { home, original, next, controlDir, marker, boundary } = JSON.parse(process.argv[1]);
            const open = fs.open;
            const remove = fs.rm;
            let hits = 0;
            let intentPublished = false;
            const rename = fs.rename;
            fs.rename = async (...args) => {
                await rename(...args);
                if (String(args[1]).endsWith('/committed')) intentPublished = true;
            };
            fs.open = async (...args) => {
                const handle = await open(...args);
                if (boundary === 'commit-intent-sync' && intentPublished && String(args[0]).startsWith(controlDir + '/.config-transaction-') && args[1] === 'r') {
                    handle.sync = async () => { hits++; throw new Error('injected commit intent fsync EIO'); };
                }
                return handle;
            };
            fs.rm = async (path, options) => {
                if (boundary === 'marker-removal' && path === marker) {
                    hits++;
                    throw new Error('injected marker removal EIO');
                }
                await remove(path, options);
            };
            syncBuiltinESMExports();
            const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
            const { ConfigEngine } = await import(${JSON.stringify(engineUrl)});
            let current = original;
            let runtimeCalls = 0;
            const engine = new ConfigEngine({
                configStore: new ControlConfigStore(), homeDirectory: home,
                getConfig: () => current, setConfig: (value) => { current = value; },
                runtimeApply: { async apply() { runtimeCalls++; return true; } },
            });
            await assert.rejects(engine.commit(original, next, [], { instanceAuth: false, mcp: false, web: true }, false), AggregateError);
            assert.equal(hits, 1);
            assert.equal(engine.current.web.listenPort, 17892);
            assert.equal(runtimeCalls, 0);
            assert.match(await fs.readFile(marker, 'utf8'), /^[0-9a-f-]{36}$/);
            process.stdout.write('uncommitted');
        `, { ...fixture, boundary }), "uncommitted");
        t.mock.method(console, "warn", () => undefined);
        assert.equal((await new ControlConfigStore().readOrCreate(fixture.home)).web.listenPort, 17892);
        assert.deepEqual(await Promise.all(fixture.files.map((file) => readFile(file, "utf8"))), fixture.bytes);
    });
}
