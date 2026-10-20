import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlPathHome, normalizeConfigInstanceDraft } from "@portable-devshell/shared";

import { toWorkerConfig } from "../../../../src/instance/model/Instance.ts";
import { WorkerRuntimeFactory } from "../../../../src/instance/runtime/provision/Factory.ts";

test("different Instances in one Control Home use one persistent physical-container claim directory", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "existing-resource-path-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const originalCreate = WorkerRuntimeFactory.create;
    const directories: string[] = [];
    t.mock.method(WorkerRuntimeFactory, "create", (options: Parameters<typeof originalCreate>[0]) => {
        if (options.type === "docker" || options.type === "podman") {
            assert.ok(options.adoption?.databaseFile);
            assert.ok(options.adoption.resourceDirectory);
            directories.push(options.adoption.resourceDirectory);
        }
        return originalCreate(options);
    });
    for (const [name, provider] of [
        ["alpha", "podman"],
        ["beta", "podman"],
        ["gamma", "docker"],
    ] as const) {
        toWorkerConfig(normalizeConfigInstanceDraft({
            name, provider,
            container: { mode: "existingStoppedContainer", containerName: "configured", adoptLifecycle: true },
        }), undefined, home);
    }
    const expected = join(new ControlPathHome(home).controlHomeDir, "container-adoption");
    assert.deepEqual(directories, [expected, expected, expected]);
});
