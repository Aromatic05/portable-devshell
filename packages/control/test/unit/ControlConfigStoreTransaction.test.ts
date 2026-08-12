import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
    ControlPathHome,
    normalizeConfigInstanceDraft
} from "@portable-devshell/shared";
import {
    ControlConfigStore,
    createDefaultControlConfig
} from "../../src/testing.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("a failed multi-file configuration write restores the previous complete generation", async (t) => {
    const homeDirectory = await createTestTempDirectory("config-transaction");
    t.after(async () => await rm(homeDirectory, { force: true, recursive: true }));
    const paths = new ControlPathHome(homeDirectory);
    const store = new ControlConfigStore();
    const original = createDefaultControlConfig();
    original.web.listenPort = 17920;
    original.instances = [normalizeConfigInstanceDraft({
        name: "alpha-local",
        provider: "local"
    })];
    await store.write(original, homeDirectory);

    const next = structuredClone(original);
    next.web.listenPort = 17921;
    next.instances.push(normalizeConfigInstanceDraft({
        name: "blocked-local",
        provider: "local"
    }));

    const blockedTarget = paths.instanceConfigFile("blocked-local");
    await mkdir(blockedTarget);
    await assert.rejects(store.write(next, homeDirectory));
    await rm(blockedTarget, { force: true, recursive: true });

    const recovered = await store.readOrCreate(homeDirectory);
    assert.equal(recovered.web.listenPort, 17920);
    assert.deepEqual(recovered.instances.map((instance) => instance.name), ["alpha-local"]);
});
