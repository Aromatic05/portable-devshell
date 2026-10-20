import assert from "node:assert/strict";
import test from "node:test";

import {
    createContainerProvision,
    type ContainerLifecycleStatus,
    type ContainerProvisionOperations,
} from "../../../../src/instance/runtime/provision/container/Provision.js";
import { existingInspect } from "./ExistingHarness.ts";
import type { WorkerCommandResult } from "../../../../src/instance/runtime/execution/Command.js";

function providerFixture(initial: ContainerLifecycleStatus) {
    let status = initial;
    const calls: Array<{ operation: string; args: string[] }> = [];
    let failNextRemove = false;
    const operations: ContainerProvisionOperations = {
        provider: "podman",
        async readContainerStatus() { return status; },
        async runProviderCommand(operation, args): Promise<WorkerCommandResult> {
            calls.push({ operation, args: [...args] });
            if (operation === "startContainer" || operation === "startContainerForRetire") status = "running";
            if (operation === "stopContainer" || operation === "stopContainerAfterRetire") status = "stopped";
            if (operation === "removeContainer") {
                if (failNextRemove) {
                    failNextRemove = false;
                    throw new Error("busy");
                }
                status = "missing";
            }
            return { exitCode: 0, stderr: "", stdout: "", details: {} };
        },
    };
    return {
        calls,
        failRemove() { failNextRemove = true; },
        provision(containerName = "round4-container") {
            return createContainerProvision({
                container: { mode: "preset", preset: "arch", containerName, image: "alpine:3", mounts: [] },
                keepIdUserNamespace: true,
                operations,
            });
        },
        status: () => status,
    };
}

test("rootless Podman provisions once, then stops and removes only the named instance container", async () => {
    const fixture = providerFixture("missing");
    const provision = fixture.provision("project-worker");

    await provision.ensureReady("start");
    assert.equal(fixture.status(), "running");
    await provision.ensureReady("reconnect");
    assert.equal(fixture.calls.filter(({ operation }) => operation === "createContainer").length, 1);
    await provision.afterWorkerStop();
    assert.equal(fixture.status(), "stopped");
    await provision.retire();
    assert.equal(fixture.status(), "missing");
    assert.deepEqual(fixture.calls.map(({ operation }) => operation), [
        "createContainer", "startContainer", "stopContainer", "removeContainer",
    ]);
    assert.deepEqual(fixture.calls[0]?.args.slice(0, 4), ["create", "--name", "project-worker", "--userns=keep-id"]);
    assert.deepEqual(fixture.calls.at(-1)?.args, ["rm", "-f", "project-worker"]);
});

test("failed managed-container deletion remains observable and a later retire retries", async () => {
    const fixture = providerFixture("running");
    const provision = fixture.provision("retry-delete");
    fixture.failRemove();

    await assert.rejects(provision.retire(), /busy/u);
    assert.equal(fixture.status(), "running");
    await provision.retire();
    assert.equal(fixture.status(), "missing");
    assert.deepEqual(fixture.calls.map(({ operation }) => operation), ["removeContainer", "removeContainer"]);
});

test("adopted stopped-container lifecycle restores state after runtime retirement", async () => {
    let status: ContainerLifecycleStatus = "stopped";
    const calls: string[] = [];
    const provision = createContainerProvision({
        container: { mode: "existingStoppedContainer", containerName: "adopt-runtime", adoptLifecycle: true },
        keepIdUserNamespace: true,
        operations: {
            provider: "podman",
            async readContainerStatus() { return status; },
            async runProviderCommand(operation): Promise<WorkerCommandResult> {
                if (operation === "inspectContainerIdentity") return { exitCode: 0, stderr: "", stdout: existingInspect(status), details: {} };
                calls.push(operation);
                status = operation === "stopContainer" ? "stopped" : "running";
                return { exitCode: 0, stderr: "", stdout: "", details: {} };
            },
        },
    });
    await provision.ensureReady("start");
    assert.equal(status, "running");
    await provision.afterWorkerStop();
    assert.equal(status, "stopped");
    await provision.ensureReady("start");
    assert.equal(status, "running");
    assert.deepEqual(calls, ["startContainer", "stopContainer", "startContainer"]);
});

test("retirement of an already stopped adopted container brackets runtime work and restores stopped state", async () => {
    let status: ContainerLifecycleStatus = "stopped";
    const calls: string[] = [];
    const provision = createContainerProvision({
        container: { mode: "existingStoppedContainer", containerName: "retire-stopped", adoptLifecycle: true },
        keepIdUserNamespace: false,
        operations: {
            provider: "docker",
            async readContainerStatus() { return status; },
            async runProviderCommand(operation): Promise<WorkerCommandResult> {
                if (operation === "inspectContainerIdentity") return { exitCode: 0, stderr: "", stdout: existingInspect(status), details: {} };
                calls.push(operation);
                status = operation === "stopContainerAfterRetire" ? "stopped" : "running";
                return { exitCode: 0, stderr: "", stdout: "", details: {} };
            },
        },
    });

    assert.equal(await provision.prepareRuntimeRetire(), true);
    assert.equal(status, "running");
    await provision.finishRuntimeRetire();
    assert.equal(status, "stopped");
    await provision.finishRuntimeRetire();
    assert.deepEqual(calls, ["startContainerForRetire", "stopContainerAfterRetire"]);
});
