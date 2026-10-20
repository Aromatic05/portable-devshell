import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { ControlPathHome, createDefaultControlConfig, normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import { ControlConfigStore } from "../../packages/control/src/config/store/index.ts";
import { createTestTempDirectory } from "../TestTempDirectory.ts";
import { runPersistenceProcess } from "../../packages/control/test/unit/control/config/persistence/CrashProcess.ts";

const moduleUrl = new URL("../../packages/control/src/config/store/index.ts", import.meta.url).href;
test("partial recursive backup cleanup must never leave a mixed configuration generation", async (t) => {
    const home = await createTestTempDirectory("partial-commit-cleanup");
    t.after(() => rm(home, { recursive: true, force: true }));
    const original = createDefaultControlConfig();
    original.web.listenPort = 17920;
    original.instances = [normalizeConfigInstanceDraft({ name: "alpha-local", provider: "local" })];
    await new ControlConfigStore().write(original, home);
    const next = structuredClone(original);
    next.web.listenPort = 17921;
    next.instances[0]!.enabled = false;
    next.instances.push(normalizeConfigInstanceDraft({ name: "new-local", provider: "local" }));
    const evidence = JSON.parse(runPersistenceProcess(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import { join } from 'node:path';
        import { syncBuiltinESMExports } from 'node:module';
        const { home, next } = JSON.parse(process.argv[1]);
        const rm = fs.rm;
        let hits = 0;
        fs.rm = async (path, options) => {
            if (hits === 0 && options?.recursive && String(path).includes('/.config-transaction-')) {
                hits++;
                // Recursive deletion can remove some children before EIO/EACCES.
                await rm(join(path, 'backup', 'instances', 'alpha-local.toml'));
                throw Object.assign(new Error('injected partial backup cleanup EIO'), { code: 'EIO' });
            }
            return await rm(path, options);
        };
        syncBuiltinESMExports();
        const { ControlConfigStore } = await import(${JSON.stringify(moduleUrl)});
        await assert.rejects(new ControlConfigStore().write(next, home), AggregateError);
        assert.equal(hits, 1);
        process.stdout.write(JSON.stringify(await new ControlConfigStore().readOrCreate(home)));
    `, { home, next }));
    await assert.rejects(readFile(new ControlPathHome(home).controlHomeDir + "/.config-transaction"), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(JSON.stringify(await new ControlConfigStore().readOrCreate(home))), evidence);
    // Marker removal and directory sync precede backup garbage collection.
    // A cleanup error cannot roll back the already committed generation.
    assert.deepEqual({ port: evidence.web.listenPort, instances: evidence.instances.map((entry: { name: string; enabled: boolean }) => [entry.name, entry.enabled]) },
        { port: 17921, instances: [["alpha-local", false], ["new-local", true]] });
});
