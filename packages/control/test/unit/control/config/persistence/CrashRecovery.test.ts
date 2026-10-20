import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ControlPathHome, createDefaultControlConfig, normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import { ControlConfigStore } from "../../../../../src/config/store/index.ts";
import { createTestTempDirectory } from "../../../../../../../test/TestTempDirectory.ts";
import { runPersistenceProcess } from "./CrashProcess.ts";

const storeModule = new URL("../../../../../src/config/store/index.ts", import.meta.url).href;
const writer = `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const { home, config, operation, target } = JSON.parse(process.argv[1]);
const original = fs[operation];
fs[operation] = async (...args) => {
    const result = await original(...args);
    const destination = operation === 'rename' ? args[1] : args[0];
    if (destination === target) process.kill(process.pid, 'SIGKILL');
    return result;
};
syncBuiltinESMExports();
const { ControlConfigStore } = await import(${JSON.stringify(storeModule)});
await new ControlConfigStore().write(config, home);
throw new Error('crash stage was not reached');
`;

for (const stage of [
    { name: "journal publication", operation: "rename", target: "marker", committed: false },
    { name: "partial instance replacement", operation: "rename", target: "added", committed: false },
    { name: "stale instance deletion", operation: "rm", target: "stale", committed: false },
    { name: "commit marker deletion", operation: "rm", target: "marker", committed: true },
] as const) {
    test(`ConfigTransaction restart after ${stage.name} ${stage.committed ? "retains the committed generation" : "restores the complete previous generation"}`, async (t) => {
        const home = await createTestTempDirectory("config-crash");
        t.after(async () => await rm(home, { recursive: true, force: true }));
        const paths = new ControlPathHome(home);
        const original = createDefaultControlConfig();
        original.web.listenPort = 17920;
        original.instances = ["alpha-local", "stale-local"].map((name) => normalizeConfigInstanceDraft({ name, provider: "local" }));
        await new ControlConfigStore().write(original, home);
        const oldGlobal = await readFile(paths.configFile, "utf8");
        const oldAlpha = await readFile(paths.instanceConfigFile("alpha-local"), "utf8");
        const oldStale = await readFile(paths.instanceConfigFile("stale-local"), "utf8");
        const unrelated = join(paths.instancesDir, "operator-notes.txt");
        await writeFile(unrelated, "preserve unrelated data");
        const next = structuredClone(original);
        next.web.listenPort = 17921;
        next.instances = ["alpha-local", "added-local"].map((name) => normalizeConfigInstanceDraft({ name, provider: "local", enabled: name !== "alpha-local" }));
        const marker = join(paths.controlHomeDir, ".config-transaction");
        const targets = { marker, added: paths.instanceConfigFile("added-local"), stale: paths.instanceConfigFile("stale-local") };
        runPersistenceProcess(writer, { home, config: next, operation: stage.operation, target: targets[stage.target] }, true);
        const interruptedFiles = await readdir(paths.controlHomeDir);
        assert.equal(interruptedFiles.includes(".config-transaction"), !stage.committed);
        assert.equal(interruptedFiles.filter((name) => name.startsWith(".config-transaction-")).length, 1);
        const expected = stage.committed ? next : original;
        const expectedGlobal = stage.committed ? await readFile(paths.configFile, "utf8") : oldGlobal;
        const expectedSources = stage.committed
            ? await Promise.all(expected.instances.map((instance) => readFile(paths.instanceConfigFile(instance.name), "utf8")))
            : [oldAlpha, oldStale];

        // A different process has no writer objects or in-memory recovery state.
        const recovered = JSON.parse(runPersistenceProcess(`
            const { ControlConfigStore } = await import(${JSON.stringify(storeModule)});
            const config = await new ControlConfigStore().readOrCreate(JSON.parse(process.argv[1]));
            process.stdout.write(JSON.stringify(config));
        `, home));
        assert.equal(recovered.web.listenPort, expected.web.listenPort);
        assert.deepEqual(
            Object.fromEntries(recovered.instances.map((instance: { name: string }) => [instance.name, instance])),
            JSON.parse(JSON.stringify(Object.fromEntries(expected.instances.map((instance) => [instance.name, instance])))),
        );
        assert.equal(await readFile(unrelated, "utf8"), "preserve unrelated data");
        assert.equal((await readdir(paths.controlHomeDir)).includes(".config-transaction"), false);
        assert.deepEqual((await readdir(paths.instancesDir)).filter((name) => name.endsWith(".toml")).sort(), expected.instances.map((instance) => `${instance.name}.toml`).sort());
        assert.equal(await readFile(paths.configFile, "utf8"), expectedGlobal);
        assert.deepEqual(await Promise.all(expected.instances.map((instance) => readFile(paths.instanceConfigFile(instance.name), "utf8"))), expectedSources);
        // A crash after commit may leave an unused backup directory, but it
        // cannot cause the next reader to roll back a committed generation.
        assert.equal((await readdir(paths.controlHomeDir)).filter((name) => name.startsWith(".config-transaction-")).length, stage.committed ? 1 : 0);
        assert.deepEqual(JSON.parse(JSON.stringify(await new ControlConfigStore().readOrCreate(home))), recovered);
    });
}
