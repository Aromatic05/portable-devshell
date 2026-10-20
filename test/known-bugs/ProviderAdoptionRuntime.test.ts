import assert from "node:assert/strict";
import test from "node:test";
import { ContainerProvisionExisting } from "../../packages/core/src/instance/runtime/provision/container/Existing.ts";

test("an adopted configured container remains available after runtime object reconstruction", async () => {
    let state: "stopped" | "running" = "stopped";
    const operations = {
        provider: "podman" as const,
        async readContainerStatus() { return state; },
        async runProviderCommand(_operation: string, args: string[]) {
            if (args[0] === "start") state = "running";
            if (args[0] === "stop") state = "stopped";
            return { exitCode: 0, stderr: "", stdout: "", details: {} };
        },
    };
    const config = {
        mode: "existingStoppedContainer" as const,
        containerName: "beta-round4-adopted",
        adoptLifecycle: true,
    };
    await new ContainerProvisionExisting({ config, operations }).ensureReady("start");
    // Reconstruct the provision object without terminating the daemon-owned container.
    const resumed = new ContainerProvisionExisting({ config, operations });
    assert.equal(await resumed.isAvailable(), true);
});
