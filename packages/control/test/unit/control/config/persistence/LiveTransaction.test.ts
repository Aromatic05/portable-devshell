import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ControlPathHome, createDefaultControlConfig, normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import { ControlConfigStore } from "../../../../../src/config/store/index.ts";
import { createTestTempDirectory } from "../../../../../../../test/TestTempDirectory.ts";
import { runPersistenceProcess } from "./CrashProcess.ts";

const storeUrl = new URL("../../../../../src/config/store/index.ts", import.meta.url).href;
const engineUrl = new URL("../../../../../src/config/engine/index.ts", import.meta.url).href;

async function generation(t: test.TestContext) {
    const home = await createTestTempDirectory("config-live-transaction");
    t.after(() => rm(home, { recursive: true, force: true }));
    const paths = new ControlPathHome(home);
    const original = createDefaultControlConfig();
    original.web.listenPort = 17892;
    original.instances = ["alpha-local", "stale-local"].map((name) =>
        normalizeConfigInstanceDraft({ name, provider: "local" }));
    await new ControlConfigStore().write(original, home);
    const foreign = join(paths.instancesDir, "部署_notes.toml");
    await writeFile(foreign, "operator-owned document\n");
    const next = structuredClone(original);
    next.web.listenPort = 17893;
    next.instances = [normalizeConfigInstanceDraft({ name: "alpha-local", provider: "local", enabled: false })];
    return { home, original, next, foreign, configFile: paths.configFile,
        instancesDir: paths.instancesDir, stale: paths.instanceConfigFile("stale-local"),
        marker: join(paths.controlHomeDir, ".config-transaction") };
}

for (const operation of ["inspectMigration", "migrate", "readOrCreate", "write"] as const) {
    test(`cross-process ${operation} waits for an active writer instead of rolling its journal back`, async (t) => {
    const fixture = await generation(t);
    const inspectionConfig = structuredClone(fixture.next);
    inspectionConfig.web.listenPort = 17894;
    inspectionConfig.instances[0]!.enabled = true;
    const inspector = `
        import { DatabaseSync } from 'node:sqlite';
        console.warn = () => undefined;
        const exec = DatabaseSync.prototype.exec;
        let notified = false;
        DatabaseSync.prototype.exec = function(sql) {
            try { return exec.call(this, sql); }
            catch (error) {
                if (error.errcode === 5 && !notified) {
                    notified = true;
                    process.send('waiting');
                }
                throw error;
            }
        };
        const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
        const { home, inspectionConfig } = JSON.parse(process.argv[1]);
        await new ControlConfigStore().${operation}(${operation === "write" ? "inspectionConfig, home" : "home"});
        process.send('inspected');
        process.disconnect();
    `;
    assert.equal(runPersistenceProcess(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import { spawn } from 'node:child_process';
        import { once } from 'node:events';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, next, configFile, inspectionConfig, expected } = JSON.parse(process.argv[1]);
        const rename = fs.rename;
        console.warn = () => undefined;
        let inspector;
        let inspection;
        let hits = 0;
        fs.rename = async (...args) => {
            await rename(...args);
            if (args[1] === configFile && hits++ === 0) {
                inspector = spawn(process.execPath, [
                    '--import', 'tsx', '--import', ${JSON.stringify(new URL("../../../../../../mcp/test/RegisterWorkspacePackages.mjs", import.meta.url).href)},
                    '--input-type=module', '-e', ${JSON.stringify(inspector)}, JSON.stringify({ home, inspectionConfig }),
                ], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
                inspection = once(inspector, 'exit');
                const [event] = await once(inspector, 'message');
                assert.equal(event, 'waiting');
            }
        };
        syncBuiltinESMExports();
        const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
        await new ControlConfigStore().write(next, home);
        assert.equal(hits, 1);
        assert.deepEqual(await inspection, [0, null]);
        const disk = await new ControlConfigStore().readOrCreate(home);
        assert.equal(disk.web.listenPort, expected.web.listenPort);
        assert.deepEqual(JSON.parse(JSON.stringify(disk.instances)), expected.instances);
        process.stdout.write('one-generation');
    `, { ...fixture, inspectionConfig, expected: operation === "write" ? inspectionConfig : fixture.next }), "one-generation");
    assert.equal(await readFile(fixture.foreign, "utf8"), "operator-owned document\n");
    });
}

test("one-shot valid Instance read EIO is retained across a fresh Store and an unrelated save", async (t) => {
    const fixture = await generation(t);
    assert.equal(runPersistenceProcess(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import { join } from 'node:path';
        import { spawn } from 'node:child_process';
        import { once } from 'node:events';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, instancesDir } = JSON.parse(process.argv[1]);
        const target = join(instancesDir, 'alpha-local.toml');
        const read = fs.readFile;
        const original = await read(target, 'utf8');
        let hits = 0;
        fs.readFile = async (path, ...args) => {
            if (path === target && hits++ === 0)
                throw Object.assign(new Error('one-shot EIO'), { code: 'EIO' });
            return read(path, ...args);
        };
        syncBuiltinESMExports();
        console.warn = () => undefined;
        const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
        const loaded = await new ControlConfigStore().readOrCreate(home);
        assert.deepEqual(loaded.instances.map(x => x.name), ['stale-local']);
        fs.readFile = read;
        syncBuiltinESMExports();
        // Candidate-version inspection is not an explicit reload of the live Config.
        await new ControlConfigStore().inspectMigration(home);
        loaded.control.logLevel = 'debug';
        loaded.instances = [];
        const save = spawn(process.execPath, [
            '--import', 'tsx', '--import', ${JSON.stringify(new URL("../../../../../../mcp/test/RegisterWorkspacePackages.mjs", import.meta.url).href)},
            '--input-type=module', '-e', ${JSON.stringify(`
                console.warn = () => undefined;
                const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
                const { home, loaded } = JSON.parse(process.argv[1]);
                await new ControlConfigStore().write(loaded, home);
            `)}, JSON.stringify({ home, loaded }),
        ], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
        assert.deepEqual(await once(save, 'exit'), [0, null]);
        assert.equal(await read(target, 'utf8'), original);
        await assert.rejects(read(join(instancesDir, 'stale-local.toml')), { code: 'ENOENT' });
        const reloaded = await new ControlConfigStore().readOrCreate(home);
        assert.equal(reloaded.control.logLevel, 'debug');
        assert.deepEqual(reloaded.instances.map(x => x.name), ['alpha-local']);
        // A successful explicit reload makes subsequent removal intentional.
        reloaded.instances = [];
        await new ControlConfigStore().write(reloaded, home);
        await assert.rejects(read(target), { code: 'ENOENT' });
        process.stdout.write('retained-then-removed');
    `, fixture), "retained-then-removed");
    assert.equal(await readFile(fixture.foreign, "utf8"), "operator-owned document\n");
});

test("Instance unlink is followed by its own directory fsync before marker removal or backup GC", async (t) => {
    const fixture = await generation(t);
    assert.equal(runPersistenceProcess(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, next, stale, instancesDir, marker } = JSON.parse(process.argv[1]);
        const open = fs.open;
        const remove = fs.rm;
        const operations = [];
        fs.open = async (...args) => {
            const handle = await open(...args);
            const sync = handle.sync.bind(handle);
            handle.sync = async () => { await sync(); operations.push(['sync', args[0]]); };
            return handle;
        };
        fs.rm = async (...args) => { await remove(...args); operations.push(['rm', args[0]]); };
        syncBuiltinESMExports();
        console.warn = () => undefined;
        const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
        await new ControlConfigStore().write(next, home);
        const deleted = operations.findIndex(([op, path]) => op === 'rm' && path === stale);
        const published = operations.findIndex(([op, path]) => op === 'rm' && path === marker);
        assert.ok(deleted >= 0);
        assert.ok(published > deleted);
        assert.ok(operations.slice(deleted + 1, published).some(([op, path]) => op === 'sync' && path === instancesDir));
        process.stdout.write('durable-delete');
    `, fixture), "durable-delete");
});

for (const scenario of [
    { name: "before the next mutation", afterEffect: true, automatic: false, port: 17893, calls: 1 },
    { name: "automatically without another edit", afterEffect: true, automatic: true, port: 17893, calls: 1 },
    { name: "by recovering a remaining live marker", afterEffect: false, automatic: false, port: 17892, calls: 0 },
]) {
    test(`uncertain unlink reconciles disk, memory and runtime ${scenario.name}`, async (t) => {
    const fixture = await generation(t);
    assert.equal(runPersistenceProcess(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, original, next, marker, scenario } = JSON.parse(process.argv[1]);
        const read = fs.readFile;
        const remove = fs.rm;
        let removed = false;
        let probes = 0;
        fs.rm = async (path, ...args) => {
            if (path === marker && !scenario.afterEffect) {
                removed = true;
                throw Object.assign(new Error('before-effect EIO'), { code: 'EIO' });
            }
            await remove(path, ...args);
            if (path === marker) { removed = true; throw Object.assign(new Error('after-effect EIO'), { code: 'EIO' }); }
        };
        fs.readFile = async (path, ...args) => {
            if (path === marker && removed && probes++ === 0)
                throw Object.assign(new Error('probe EACCES'), { code: 'EACCES' });
            return read(path, ...args);
        };
        syncBuiltinESMExports();
        console.warn = () => undefined;
        const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
        const { ConfigEngine } = await import(${JSON.stringify(engineUrl)});
        let current = original;
        let calls = 0;
        let restartRequired = false;
        let applied;
        const application = new Promise(resolve => { applied = resolve; });
        const engine = new ConfigEngine({
            configStore: new ControlConfigStore(), homeDirectory: home,
            getConfig: () => current, setConfig: value => { current = value; },
            getRestartControlRequired: () => restartRequired,
            markRestartControlRequired: () => { restartRequired = true; },
            runtimeApply: { async apply(previous, value) {
                calls++;
                assert.equal(previous.web.listenPort, 17892);
                assert.equal(value.web.listenPort, 17893);
                applied();
                return true;
            } },
        });
        await assert.rejects(engine.commit(original, next, [], { instanceAuth: false, mcp: false, web: true }, false), AggregateError);
        assert.equal(current.web.listenPort, 17892);
        assert.equal(calls, 0);
        fs.readFile = read;
        fs.rm = remove;
        syncBuiltinESMExports();
        ${scenario.automatic ? `
            // Hold this disposable process open; the Engine retry itself is unref'ed.
            const timeout = setTimeout(() => { throw new Error('automatic reconciliation did not run'); }, 5000);
            await application;
            clearTimeout(timeout);
        ` : ""}
        await engine.runExclusive(async () => {
            assert.equal(engine.current.web.listenPort, scenario.port);
            assert.equal(calls, scenario.calls);
            assert.equal(engine.restartControlRequired, scenario.afterEffect);
            assert.deepEqual(JSON.parse(JSON.stringify(await new ControlConfigStore().readOrCreate(home))), JSON.parse(JSON.stringify(engine.current)));
        });
        process.stdout.write('reconciled');
    `, { ...fixture, scenario }), "reconciled");
    });
}

for (const outcome of ["commit", "rollback"] as const) {
    test(`persistently unreadable unrelated Instance stays untouched through ${outcome}`, async (t) => {
        const fixture = await generation(t);
        assert.equal(runPersistenceProcess(`
            import assert from 'node:assert/strict';
            import fs from 'node:fs/promises';
            import { join, dirname } from 'node:path';
            import { syncBuiltinESMExports } from 'node:module';
            const { home, instancesDir, configFile } = JSON.parse(process.argv[1]);
            const target = join(instancesDir, 'alpha-local.toml');
            const read = fs.readFile;
            const rename = fs.rename;
            const bytes = await read(target, 'utf8');
            fs.readFile = async (path, ...args) => {
                if (path === target) throw Object.assign(new Error('persistent read EIO'), { code: 'EIO' });
                return read(path, ...args);
            };
            syncBuiltinESMExports();
            console.warn = () => undefined;
            const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
            const store = new ControlConfigStore();
            const config = await store.readOrCreate(home);
            assert.deepEqual(config.instances.map(x => x.name), ['stale-local']);
            config.control.logLevel = 'debug';
            config.instances = [];
            ${outcome === "rollback" ? `
                let hits = 0;
                fs.rename = async (from, to) => {
                    if (to === configFile && hits++ === 0) throw Object.assign(new Error('global rename EIO'), { code: 'EIO' });
                    return rename(from, to);
                };
                syncBuiltinESMExports();
                await assert.rejects(store.write(config, home));
                assert.equal(hits, 2);
            ` : "await store.write(config, home);"}
            assert.equal(await read(target, 'utf8'), bytes);
            fs.readFile = read;
            fs.rename = rename;
            syncBuiltinESMExports();
            const reloaded = await store.readOrCreate(home);
            assert.equal(reloaded.control.logLevel, ${JSON.stringify(outcome === "commit" ? "debug" : "info")});
            assert.deepEqual(reloaded.instances.map(x => x.name), ${JSON.stringify(outcome === "commit" ? ["alpha-local"] : ["alpha-local", "stale-local"])});
            process.stdout.write('unreadable-preserved');
        `, fixture), "unreadable-preserved");
        assert.equal(await readFile(fixture.foreign, "utf8"), "operator-owned document\n");
    });
}

test("Instance deletion fsync EIO rolls back before the marker and backups are discarded", async (t) => {
    const fixture = await generation(t);
    assert.equal(runPersistenceProcess(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, original, next, stale, instancesDir, marker } = JSON.parse(process.argv[1]);
        const remove = fs.rm;
        const open = fs.open;
        let deleted = false;
        let hits = 0;
        fs.rm = async (...args) => {
            await remove(...args);
            if (args[0] === stale) deleted = true;
        };
        fs.open = async (...args) => {
            const handle = await open(...args);
            const sync = handle.sync.bind(handle);
            if (args[0] === instancesDir && args[1] === 'r') handle.sync = async () => {
                if (deleted && hits === 0) {
                    hits++;
                    throw Object.assign(new Error('Instance deletion fsync EIO'), { code: 'EIO' });
                }
                await sync();
            };
            return handle;
        };
        syncBuiltinESMExports();
        console.warn = () => undefined;
        const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
        await assert.rejects(new ControlConfigStore().write(next, home), { code: 'EIO' });
        assert.equal(hits, 1);
        assert.deepEqual(JSON.parse(JSON.stringify(await new ControlConfigStore().readOrCreate(home))), original);
        await assert.rejects(fs.readFile(marker), { code: 'ENOENT' });
        process.stdout.write('delete-rolled-back');
    `, fixture), "delete-rolled-back");
});

test("recovery retains its journal when fsync after unlinking a new Instance fails, then retries durably", async (t) => {
    const fixture = await generation(t);
    const paths = new ControlPathHome(fixture.home);
    fixture.next.instances.push(normalizeConfigInstanceDraft({ name: "added-local", provider: "local" }));
    const added = paths.instanceConfigFile("added-local");
    const files = [fixture.configFile, paths.instanceConfigFile("alpha-local"), fixture.stale, fixture.foreign];
    const bytes = await Promise.all(files.map((file) => readFile(file, "utf8")));
    runPersistenceProcess(`
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, next, stale } = JSON.parse(process.argv[1]);
        const remove = fs.rm;
        fs.rm = async (...args) => {
            await remove(...args);
            if (args[0] === stale) process.kill(process.pid, 'SIGKILL');
        };
        syncBuiltinESMExports();
        const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
        await new ControlConfigStore().write(next, home);
        throw new Error('writer never reached deletion');
    `, fixture, true);
    assert.equal(runPersistenceProcess(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, added, instancesDir, marker } = JSON.parse(process.argv[1]);
        const remove = fs.rm;
        const open = fs.open;
        const operations = [];
        let deleted = false;
        let hits = 0;
        fs.rm = async (...args) => {
            await remove(...args);
            operations.push(['rm', args[0]]);
            if (args[0] === added) deleted = true;
        };
        fs.open = async (...args) => {
            const handle = await open(...args);
            const sync = handle.sync.bind(handle);
            handle.sync = async () => {
                if (args[0] === instancesDir && deleted && hits === 0) {
                    hits++;
                    throw Object.assign(new Error('recovery deletion fsync EIO'), { code: 'EIO' });
                }
                await sync();
                operations.push(['sync', args[0]]);
            };
            return handle;
        };
        syncBuiltinESMExports();
        console.warn = () => undefined;
        const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
        await assert.rejects(new ControlConfigStore().readOrCreate(home), { code: 'EIO' });
        assert.equal(hits, 1);
        assert.match(await fs.readFile(marker, 'utf8'), /^[0-9a-f-]{36}$/);
        await new ControlConfigStore().readOrCreate(home);
        const deletion = operations.findIndex(([op, path]) => op === 'rm' && path === added);
        const publication = operations.findIndex(([op, path]) => op === 'rm' && path === marker);
        assert.ok(deletion >= 0);
        assert.ok(publication > deletion);
        assert.ok(operations.slice(deletion + 1, publication).some(([op, path]) => op === 'sync' && path === instancesDir));
        await assert.rejects(fs.readFile(added), { code: 'ENOENT' });
        process.stdout.write('recovery-retried');
    `, { ...fixture, added }), "recovery-retried");
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), bytes);
});

for (const durabilityFailure of [false, true]) {
    test(`an explicit successful replacement clears skipped-file protection with durability failure=${durabilityFailure}`, async (t) => {
        const fixture = await generation(t);
        assert.equal(runPersistenceProcess(`
            import assert from 'node:assert/strict';
            import fs from 'node:fs/promises';
            import { join, dirname } from 'node:path';
            import { syncBuiltinESMExports } from 'node:module';
            const { home, next, instancesDir, marker } = JSON.parse(process.argv[1]);
            const target = join(instancesDir, 'alpha-local.toml');
            const read = fs.readFile;
            const open = fs.open;
            const remove = fs.rm;
            let reads = 0;
            fs.readFile = async (path, ...args) => {
                if (path === target && reads++ === 0) throw Object.assign(new Error('initial EIO'), { code: 'EIO' });
                return read(path, ...args);
            };
            syncBuiltinESMExports();
            console.warn = () => undefined;
            const { ControlConfigStore, ControlConfigCommittedDurabilityError } = await import(${JSON.stringify(storeUrl)});
            const store = new ControlConfigStore();
            const config = await store.readOrCreate(home);
            assert.deepEqual(config.instances.map(x => x.name), ['stale-local']);
            fs.readFile = read;
            syncBuiltinESMExports();
            ${durabilityFailure ? `
                let removed = false;
                let hits = 0;
                fs.rm = async (...args) => {
                    await remove(...args);
                    if (args[0] === marker) removed = true;
                };
                fs.open = async (...args) => {
                    const handle = await open(...args);
                    const sync = handle.sync.bind(handle);
                    if (args[0] === dirname(marker) && args[1] === 'r') handle.sync = async () => {
                        if (removed && hits === 0) { hits++; throw Object.assign(new Error('final fsync EIO'), { code: 'EIO' }); }
                        await sync();
                    };
                    return handle;
                };
                syncBuiltinESMExports();
                await assert.rejects(store.write(next, home), ControlConfigCommittedDurabilityError);
                assert.equal(hits, 1);
            ` : "await store.write(next, home);"}
            fs.open = open;
            fs.rm = remove;
            syncBuiltinESMExports();
            assert.match(await read(target, 'utf8'), /enabled = false/);
            next.instances = [];
            await store.write(next, home);
            await assert.rejects(read(target), { code: 'ENOENT' });
            process.stdout.write('replacement-is-known');
        `, fixture), "replacement-is-known");
    });
}

test("lease metadata commit failure also reconciles the already visible TOML generation", async (t) => {
    const fixture = await generation(t);
    assert.equal(runPersistenceProcess(`
        import assert from 'node:assert/strict';
        import { DatabaseSync } from 'node:sqlite';
        const { home, original, next } = JSON.parse(process.argv[1]);
        const exec = DatabaseSync.prototype.exec;
        let hits = 0;
        DatabaseSync.prototype.exec = function(sql) {
            if (sql === 'COMMIT' && hits++ === 0) throw Object.assign(new Error('metadata commit EIO'), { code: 'EIO' });
            return exec.call(this, sql);
        };
        console.warn = () => undefined;
        const { ControlConfigStore, ControlConfigCommitUncertainError } = await import(${JSON.stringify(storeUrl)});
        const { ConfigEngine } = await import(${JSON.stringify(engineUrl)});
        let current = original;
        let calls = 0;
        const engine = new ConfigEngine({
            configStore: new ControlConfigStore(), homeDirectory: home,
            getConfig: () => current, setConfig: value => { current = value; },
            runtimeApply: { async apply() { calls++; return true; } },
        });
        await assert.rejects(engine.commit(original, next, [], { instanceAuth: false, mcp: false, web: true }, false), ControlConfigCommitUncertainError);
        assert.equal(current.web.listenPort, original.web.listenPort);
        await engine.runExclusive(async () => {
            assert.equal(current.web.listenPort, next.web.listenPort);
            assert.equal(calls, 1);
        });
        assert.equal(hits, 2);
        process.stdout.write('metadata-reconciled');
    `, fixture), "metadata-reconciled");
});

test("commit reconciliation retains the existing MCP approval and Web OAuth2 runtime coupling", async (t) => {
    const fixture = await generation(t);
    fixture.original.mcp.enabled = true;
    fixture.original.web.enabled = true;
    fixture.original.web.auth = { mode: "oauth2", oauth2: { requiredScopes: ["web"], resourceName: "web" } };
    await new ControlConfigStore().write(fixture.original, fixture.home);
    fixture.next = structuredClone(fixture.original);
    fixture.next.mcp.oauth2 = { approval: "token", token: "o".repeat(48) };
    assert.equal(runPersistenceProcess(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, original, next, marker } = JSON.parse(process.argv[1]);
        const remove = fs.rm;
        const read = fs.readFile;
        let removed = false;
        fs.rm = async (...args) => {
            await remove(...args);
            if (args[0] === marker) { removed = true; throw Object.assign(new Error('unlink EIO'), { code: 'EIO' }); }
        };
        fs.readFile = async (path, ...args) => {
            if (path === marker && removed) throw Object.assign(new Error('probe EIO'), { code: 'EIO' });
            return read(path, ...args);
        };
        syncBuiltinESMExports();
        console.warn = () => undefined;
        const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
        const { ConfigEngine } = await import(${JSON.stringify(engineUrl)});
        let current = original;
        const changes = [];
        const engine = new ConfigEngine({
            configStore: new ControlConfigStore(), homeDirectory: home,
            getConfig: () => current, setConfig: value => { current = value; },
            runtimeApply: { async apply(_previous, _next, flags) { changes.push(flags); return true; } },
        });
        await assert.rejects(engine.commit(original, next, [], { instanceAuth: false, mcp: true, web: true }, false), AggregateError);
        fs.rm = remove;
        fs.readFile = read;
        syncBuiltinESMExports();
        await engine.runExclusive(async () => undefined);
        assert.deepEqual(changes, [{ instanceAuth: false, mcp: true, web: true }]);
        assert.equal(current.mcp.oauth2.token, next.mcp.oauth2.token);
        process.stdout.write('coupling-preserved');
    `, fixture), "coupling-preserved");
});
