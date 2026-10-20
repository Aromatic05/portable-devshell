import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerProvisionExisting } from "../../../../src/instance/runtime/provision/container/Existing.ts";

test("an adopted configured container remains available after runtime object reconstruction", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "adoption-reproducer-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const adoption = { databaseFile: join(root, "adoption.sqlite3"), owner: "beta-round4-adopted/config-1" };
    let state: "stopped" | "running" = "stopped";
    const operations = {
        provider: "podman" as const,
        async readContainerStatus() { return state; },
        async runProviderCommand(_operation: string, args: string[]) {
            if (args[0] === "start") state = "running";
            if (args[0] === "stop") state = "stopped";
            return { exitCode: 0, stderr: "", stdout: args[0] === "inspect" ? JSON.stringify([{ Id: "a".repeat(64), State: { Status: state, StartedAt: "2026-10-20T01:00:00Z" } }]) : "", details: {} };
        },
    };
    const config = {
        mode: "existingStoppedContainer" as const,
        containerName: "beta-round4-adopted",
        adoptLifecycle: true,
    };
    await new ContainerProvisionExisting({ adoption, config, operations }).ensureReady("start");
    // Reconstruct the provision object without terminating the daemon-owned container.
    const resumed = new ContainerProvisionExisting({ adoption, config, operations });
    assert.equal(await resumed.isAvailable(), true);
});
