import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlPathHome, createDefaultControlConfig, normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import { ControlConfigStore } from "../../../../src/config/store/index.ts";

test("invalid Instance config is isolated and preserved by later config writes", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "devshell-config-degraded-"));
    t.after(async () => await rm(home, { force: true, recursive: true }));
    const store = new ControlConfigStore();
    const config = createDefaultControlConfig();
    config.instances = [normalizeConfigInstanceDraft({ name: "good-local", provider: "local" })];
    await store.write(config, home);
    const badFile = join(new ControlPathHome(home).instancesDir, "broken.toml");
    const badContent = 'version = "broken"\n';
    await writeFile(badFile, badContent);
    const warn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
        const loaded = await store.readOrCreate(home);
        assert.deepEqual(loaded.instances.map((instance) => instance.name), ["good-local"]);
        assert.equal(warnings.length, 1);
        await new ControlConfigStore().write(loaded, home);
        assert.equal(warnings.length, 2);
        assert.equal(await readFile(badFile, "utf8"), badContent);
    } finally {
        console.warn = warn;
    }
});

test("creating a missing global config never deletes existing Instance files", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "devshell-config-recover-"));
    t.after(async () => await rm(home, { force: true, recursive: true }));
    const store = new ControlConfigStore();
    const config = createDefaultControlConfig();
    config.instances = [normalizeConfigInstanceDraft({ name: "old-local", provider: "local" })];
    await store.write(config, home);
    const paths = new ControlPathHome(home);
    const oldFile = paths.instanceConfigFile("old-local");
    const oldContent = await readFile(oldFile, "utf8");
    await rm(paths.configFile);

    await new ControlConfigStore().readOrCreate(home);
    assert.equal(await readFile(oldFile, "utf8"), oldContent);
    const recovered = await new ControlConfigStore().readOrCreate(home);
    assert.deepEqual(recovered.instances.map((instance) => instance.name), ["old-local"]);
});
