import assert from "node:assert/strict";
import { cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ControlPathHome, createDefaultControlConfig, normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import { ControlConfigStore } from "../../../../../src/config/store/index.ts";
import { createTestTempDirectory } from "../../../../../../../test/TestTempDirectory.ts";
import { runPersistenceProcess } from "./CrashProcess.ts";

const moduleUrl = new URL("../../../../../src/config/store/index.ts", import.meta.url).href;
const read = `const { ControlConfigStore } = await import(${JSON.stringify(moduleUrl)});
process.stdout.write(JSON.stringify(await new ControlConfigStore().readOrCreate(JSON.parse(process.argv[1]))));`;

async function interrupted(t: test.TestContext) {
    const home = await createTestTempDirectory("recovery-interruption");
    t.after(() => rm(home, { recursive: true, force: true }));
    const paths = new ControlPathHome(home);
    const original = createDefaultControlConfig();
    original.web.listenPort = 17920;
    original.instances = ["alpha-local", "stale-local"].map((name) => normalizeConfigInstanceDraft({ name, provider: "local" }));
    await new ControlConfigStore().write(original, home);
    const foreign = join(paths.instancesDir, "operator-notes.toml");
    await writeFile(foreign, "invalid TOML retained for manual recovery");
    const files = [paths.configFile, ...original.instances.map((entry) => paths.instanceConfigFile(entry.name)), foreign];
    const bytes = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const next = structuredClone(original);
    next.web.listenPort = 17921;
    next.instances = ["alpha-local", "added-local"].map((name) => normalizeConfigInstanceDraft({ name, provider: "local", enabled: false }));
    runPersistenceProcess(`
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, next, stale } = JSON.parse(process.argv[1]);
        const rm = fs.rm;
        fs.rm = async (...args) => {
            await rm(...args);
            if (args[0] === stale) process.kill(process.pid, 'SIGKILL');
        };
        syncBuiltinESMExports();
        const { ControlConfigStore } = await import(${JSON.stringify(moduleUrl)});
        await new ControlConfigStore().write(next, home);
        throw new Error('writer kill boundary not reached');
    `, { home, next, stale: paths.instanceConfigFile("stale-local") }, true);
    return { home, paths, original, files, bytes };
}

for (const boundary of ["global", "instance", "added-removal", "marker-removal"] as const) {
    test(`recovery survives SIGKILL during its own ${boundary} and a second restart`, async (t) => {
        const { home, paths, original, files, bytes } = await interrupted(t);
        const marker = join(paths.controlHomeDir, ".config-transaction");
        const target = { global: paths.configFile, instance: paths.instanceConfigFile("alpha-local"),
            "added-removal": paths.instanceConfigFile("added-local"), "marker-removal": marker }[boundary];
        runPersistenceProcess(`
            import fs from 'node:fs/promises';
            import { syncBuiltinESMExports } from 'node:module';
            const { home, target, boundary } = JSON.parse(process.argv[1]);
            const operation = boundary.endsWith('removal') ? 'rm' : 'rename';
            const original = fs[operation];
            fs[operation] = async (...args) => {
                await original(...args);
                if (args[operation === 'rename' ? 1 : 0] === target) process.kill(process.pid, 'SIGKILL');
            };
            syncBuiltinESMExports();
            const { ControlConfigStore } = await import(${JSON.stringify(moduleUrl)});
            await new ControlConfigStore().readOrCreate(home);
            throw new Error('recovery kill boundary not reached');
        `, { home, target, boundary }, true);
        assert.equal((await readdir(paths.controlHomeDir)).includes(".config-transaction"), boundary !== "marker-removal");
        const recovered = JSON.parse(runPersistenceProcess(read, home));
        assert.equal(recovered.web.listenPort, original.web.listenPort);
        assert.deepEqual(recovered.instances.map((entry: { name: string }) => entry.name), ["alpha-local", "stale-local"]);
        assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), bytes);
        assert.deepEqual((await readdir(paths.instancesDir)).filter((name) => name.endsWith(".toml")).sort(), ["alpha-local.toml", "operator-notes.toml", "stale-local.toml"]);
        assert.deepEqual(JSON.parse(runPersistenceProcess(read, home)), recovered);
    });
}

for (const fault of ["rename", "fsync"] as const) {
    test(`recovery ${fault} failure preserves the journal for an independent retry`, async (t) => {
        const { home, paths, files, bytes } = await interrupted(t);
        const marker = join(paths.controlHomeDir, ".config-transaction");
        const before = await readFile(marker, "utf8");
        const output = runPersistenceProcess(`
            import assert from 'node:assert/strict';
            import fs from 'node:fs/promises';
            import { syncBuiltinESMExports } from 'node:module';
            const { home, target, fault } = JSON.parse(process.argv[1]);
            let hits = 0;
            const rename = fs.rename;
            const open = fs.open;
            fs.rename = async (...args) => {
                if (fault === 'rename' && args[1] === target) { hits++; throw new Error('injected recovery rename'); }
                return await rename(...args);
            };
            fs.open = async (...args) => {
                const handle = await open(...args);
                if (fault === 'fsync' && String(args[0]).startsWith(target + '.tmp-')) {
                    handle.sync = async () => { hits++; throw new Error('injected recovery fsync'); };
                }
                return handle;
            };
            syncBuiltinESMExports();
            const { ControlConfigStore } = await import(${JSON.stringify(moduleUrl)});
            await assert.rejects(new ControlConfigStore().readOrCreate(home), /Failed to write control config/);
            assert.equal(hits, 1);
            process.stdout.write('fault observed');
        `, { home, target: paths.configFile, fault });
        assert.equal(output, "fault observed");
        assert.equal(await readFile(marker, "utf8"), before);
        runPersistenceProcess(read, home);
        assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), bytes);
        await assert.rejects(readFile(marker), { code: "ENOENT" });
        const recovered = runPersistenceProcess(read, home);
        assert.equal(runPersistenceProcess(read, home), recovered);
    });
}

test("a stale backup without a published marker cannot roll back a subsequent generation", async (t) => {
    const { home, paths } = await interrupted(t);
    const marker = join(paths.controlHomeDir, ".config-transaction");
    const id = (await readFile(marker, "utf8")).trim();
    const stale = join(home, "stale-backup");
    await cp(join(paths.controlHomeDir, `.config-transaction-${id}`), stale, { recursive: true });
    runPersistenceProcess(read, home);
    t.mock.method(console, "warn", () => undefined);
    const config = await new ControlConfigStore().readOrCreate(home);
    config.web.listenPort = 17922;
    await new ControlConfigStore().write(config, home);
    // An unreferenced directory can survive a crash after the commit point.
    await cp(stale, join(paths.controlHomeDir, `.config-transaction-${id}`), { recursive: true });
    const before = await readFile(paths.configFile, "utf8");
    assert.equal(JSON.parse(runPersistenceProcess(read, home)).web.listenPort, 17922);
    assert.equal(await readFile(paths.configFile, "utf8"), before);
});
