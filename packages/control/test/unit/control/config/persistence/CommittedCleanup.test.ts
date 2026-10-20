import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ControlPathHome, createDefaultControlConfig, normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import { ControlConfigStore } from "../../../../../src/config/store/index.ts";
import { createTestTempDirectory } from "../../../../../../../test/TestTempDirectory.ts";
import { runPersistenceProcess } from "./CrashProcess.ts";

const storeUrl = new URL("../../../../../src/config/store/index.ts", import.meta.url).href;
const engineUrl = new URL("../../../../../src/config/engine/index.ts", import.meta.url).href;

test("post-commit backup failure publishes the committed generation and retries GC on the next write", async (t) => {
    const home = await createTestTempDirectory("config-postcommit-engine");
    t.after(() => rm(home, { force: true, recursive: true }));
    const paths = new ControlPathHome(home);
    const original = createDefaultControlConfig();
    original.web.listenPort = 17890;
    original.instances = [normalizeConfigInstanceDraft({ name: "previous-local", provider: "local" })];
    await new ControlConfigStore().write(original, home);
    const next = structuredClone(original);
    next.web.listenPort = 17891;
    next.instances.push(normalizeConfigInstanceDraft({ name: "added-local", provider: "local" }));

    assert.equal(runPersistenceProcess(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import { join } from 'node:path';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, original, next } = JSON.parse(process.argv[1]);
        const remove = fs.rm;
        let interrupted = false;
        fs.rm = async (path, options) => {
            if (!interrupted && options?.recursive && String(path).includes('/.config-transaction-')) {
                interrupted = true;
                await remove(join(path, 'backup', 'config.toml'));
                throw Object.assign(new Error('injected partial cleanup'), { code: 'EIO' });
            }
            return await remove(path, options);
        };
        syncBuiltinESMExports();
        const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
        const { ConfigEngine } = await import(${JSON.stringify(engineUrl)});
        let current = original;
        const engine = new ConfigEngine({
            configStore: new ControlConfigStore(), homeDirectory: home,
            getConfig: () => current, setConfig: (value) => { current = value; },
        });
        await engine.persist(next);
        assert.equal(interrupted, true);
        assert.equal(engine.current.web.listenPort, next.web.listenPort);
        assert.deepEqual(engine.current.instances.map(({ name }) => name), ['previous-local', 'added-local']);
        process.stdout.write('committed');
    `, { home, original, next }), "committed");

    assert.equal((await new ControlConfigStore().readOrCreate(home)).web.listenPort, 17891);
    const residual = (await readdir(paths.controlHomeDir))
        .filter((name) => name.startsWith(".config-transaction-"));
    assert.equal(residual.length, 1);
    assert.equal(await readFile(join(paths.controlHomeDir, residual[0]!, "committed"), "utf8"), "");
    await new ControlConfigStore().write(next, home);
    assert.deepEqual(
        (await readdir(paths.controlHomeDir)).filter((name) => name.startsWith(".config-transaction-")),
        [],
    );
    assert.equal((await new ControlConfigStore().readOrCreate(home)).web.listenPort, 17891);
});

test("commit marker directory fsync failure does not roll back the new generation", async (t) => {
    const home = await createTestTempDirectory("config-commit-fsync");
    t.after(() => rm(home, { force: true, recursive: true }));
    const paths = new ControlPathHome(home);
    const original = createDefaultControlConfig();
    original.web.listenPort = 17892;
    await new ControlConfigStore().write(original, home);
    const next = structuredClone(original);
    next.web.listenPort = 17893;

    assert.equal(runPersistenceProcess(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import { existsSync } from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, next, controlDir, marker } = JSON.parse(process.argv[1]);
        const open = fs.open;
        let hits = 0;
        fs.open = async (...args) => {
            const handle = await open(...args);
            if (String(args[0]) === controlDir && args[1] === 'r') {
                const sync = handle.sync.bind(handle);
                handle.sync = async () => {
                    if (!existsSync(marker) && hits++ === 0)
                        throw Object.assign(new Error('injected final fsync EIO'), { code: 'EIO' });
                    return await sync();
                };
            }
            return handle;
        };
        syncBuiltinESMExports();
        const { ControlConfigStore } = await import(${JSON.stringify(storeUrl)});
        await assert.rejects(new ControlConfigStore().write(next, home), AggregateError);
        assert.equal(hits, 1);
        process.stdout.write('failed-after-commit');
    `, { home, next, controlDir: paths.controlHomeDir, marker: join(paths.controlHomeDir, ".config-transaction") }), "failed-after-commit");
    const recovered = await new ControlConfigStore().readOrCreate(home);
    assert.equal(recovered.web.listenPort, 17893);
});
