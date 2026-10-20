import assert from "node:assert/strict";
import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { asInstanceName, normalizeConfigInstanceDraft, type ControlInstanceConfig } from "@portable-devshell/shared";
import { toWorkerConfig } from "../../../../src/instance/model/Instance.ts";
import { InstancePaths } from "../../../../src/instance/model/Paths.ts";
import { WorkerCommandClient } from "../../../../src/instance/runtime/execution/Command.ts";
import { resolveWorkerInstanceConfig } from "../../../../src/instance/runtime/provision/Config.ts";
import { WorkerRuntimeFactory } from "../../../../src/instance/runtime/provision/Factory.ts";
import { ContainerAdoptionStore, containerAdoptionOwner } from "../../../../src/instance/runtime/provision/container/Adoption.ts";
import { WorkerInstallerRemote } from "../../../../src/instance/runtime/provision/install/Remote.ts";
import { WorkerInstanceRetirement } from "../../../../src/instance/runtime/provision/Retirement.ts";
import { requiresWorkerRebuild } from "../../../../../control/src/config/engine/Result.ts";
import { existingId, existingInspect, replacementId, startedAt } from "./ExistingHarness.ts";

// Only provider processes and binary installation are faked. The model, factory,
// SQLite provenance, command client, execution and retirement paths are real.
async function fixture(t: TestContext, provider: "docker" | "podman", adoptLifecycle = false) {
    const root = await mkdtemp(join(tmpdir(), "existing-lifecycle-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let container = { id: existingId, status: "stopped", started: startedAt };
    const neighbor = { id: "c".repeat(64), status: "running", started: startedAt };
    const workerStates = new Map([["adopted", "stopped"], ["neighbor", "running"]]);
    const calls: Array<{ binary: string; args: string[] }> = [];
    const spawn = (binary: string, args: readonly string[], _options: SpawnOptions): ChildProcess => {
        calls.push({ binary, args: [...args] });
        const child = new EventEmitter() as ChildProcess;
        const stdoutStream = new PassThrough();
        const stderrStream = new PassThrough();
        child.stdin = new PassThrough();
        child.stdout = stdoutStream;
        child.stderr = stderrStream;
        setImmediate(() => {
            let stdout = "", stderr = "", code = 0;
            const executableIndex = args.indexOf("/worker/bin");
            const target = args[0] === "exec" ? args[executableIndex - 1] : args.at(-1);
            if (target !== "configured" && target !== container.id) {
                code = 125;
                stderr = "no such container";
            } else if (args[0] === "inspect") {
                stdout = existingInspect(container.status, container.id, container.started);
            } else if (args[0] === "start") {
                container.status = "running";
            } else if (args[0] === "stop") {
                container.status = "stopped";
            } else if (args[0] === "exec") {
                const command = args[executableIndex + 1];
                const instance = args[executableIndex + 3]!;
                if (command === "start") workerStates.set(instance, "running");
                if (command === "stop") workerStates.set(instance, "stopped");
                if (command === "retire") {
                    if (workerStates.get(instance) !== "stopped") {
                        code = 31;
                        stderr = "native retirement rejected stale daemon state";
                    } else workerStates.delete(instance);
                }
                stdout = JSON.stringify(command === "status"
                    ? { state: workerStates.get(instance) ?? "stopped" }
                    : { [command === "stop" ? "stopped" : command === "retire" ? "retired" : "started"]: true });
            } else {
                assert.fail(`Unexpected provider operation: ${args.join(" ")}`);
            }
            stdoutStream.end(stdout);
            stderrStream.end(stderr);
            child.emit("exit", code, null);
            child.emit("close", code, null);
        });
        return child;
    };
    const create = WorkerRuntimeFactory.create;
    t.mock.method(WorkerRuntimeFactory, "create", (options: Parameters<typeof create>[0]) => create({ ...options, ...("adoption" in options ? { adoption: { ...options.adoption!, resourceDirectory: join(root, "resources") } } : {}), spawnFunction: spawn }));
    t.mock.method(WorkerInstallerRemote.prototype, "ensure", async () => "/worker/bin");
    const instance = normalizeConfigInstanceDraft({
        name: "adopted", provider,
        container: { mode: "existingStoppedContainer", containerName: "configured", adoptLifecycle },
        approvalPolicy: { mode: "allow" },
    });
    assert.ok(instance.provider === "docker" || instance.provider === "podman");
    const adoption = new ContainerAdoptionStore(new InstancePaths(asInstanceName(instance.name), root).containerAdoptionDatabaseFile);
    const runtime = (updated: ControlInstanceConfig = instance) => {
        const config = resolveWorkerInstanceConfig(toWorkerConfig(updated, undefined, root));
        assert.ok(config.runtime);
        const client = new WorkerCommandClient(config.runtime, config.name, config.env);
        return { client, retirement: new WorkerInstanceRetirement({ config, commandClient: client }) };
    };
    return {
        instance, runtime, calls, workerStates, neighbor, adoption,
        async seedPreviousOwner(withEvidence = false) {
            await new ContainerAdoptionStore(join(root, "resources", `${existingId}.sqlite3`)).transaction(async (tx) => tx.clear());
            return await adoption.transaction(async (transaction) => {
                const record = transaction.read();
                assert.ok(record);
                const previous = { ...(withEvidence ? record : {
                    containerId: record.containerId, startedAt: record.startedAt, generation: record.generation,
                }), owner: containerAdoptionOwner([
                    containerAdoptionOwner(instance), provider, provider, instance.container,
                ]) };
                transaction.write(previous);
                return previous;
            });
        },
        container: () => container,
        replace(id = replacementId, started = startedAt) { container = { id, status: "running", started }; },
    };
}

for (const provider of ["docker", "podman"] as const) {
    test(`${provider}: worker stop without lifecycle adoption supports status, restart and full retirement`, async (t) => {
        const f = await fixture(t, provider);
        const first = f.runtime();
        assert.equal((await first.client.start()).exitCode, 0);
        assert.equal((await first.client.stop()).exitCode, 0);
        assert.equal(f.container().status, "running");
        assert.deepEqual(JSON.parse((await first.client.status()).stdout), { state: "stopped" });

        const resumed = f.runtime();
        assert.equal((await resumed.client.start()).exitCode, 0);
        assert.deepEqual(JSON.parse((await resumed.client.status()).stdout), { state: "running" });
        await resumed.retirement.retire();
        assert.equal(f.container().status, "running");
        assert.equal(f.workerStates.has("adopted"), false);
        assert.equal(f.workerStates.get("neighbor"), "running");
        assert.deepEqual(f.neighbor, { id: "c".repeat(64), status: "running", started: startedAt });
        assert.deepEqual(f.calls.filter(({ args }) => args[0] !== "inspect").map(({ args }) => args), [
            ["start", existingId],
            ...["start", "stop", "status", "start", "status", "stop", "retire"].map((command) =>
                ["exec", "-i", "-e", "DEVSHELL_WORKER_SECURITY_MODE", existingId, "/worker/bin", command, "--instance", "adopted"]),
        ]);
        const beforeRefusal = f.calls.length;
        await assert.rejects(f.runtime().client.start(), /already running/u);
        assert.deepEqual(f.calls.slice(beforeRefusal).map(({ args }) => args[0]), ["inspect"]);
    });

    test(`${provider}: full retirement directly after start stops only the worker and releases adoption`, async (t) => {
        const f = await fixture(t, provider);
        const runtime = f.runtime();
        await runtime.client.start();
        await runtime.retirement.retire();
        assert.equal(f.container().status, "running");
        assert.equal(f.workerStates.has("adopted"), false);
        assert.equal(f.workerStates.get("neighbor"), "running");
        assert.deepEqual(f.calls.filter(({ args }) => args[0] !== "inspect").map(({ args }) => args), [
            ["start", existingId],
            ...["start", "stop", "retire"].map((command) =>
                ["exec", "-i", "-e", "DEVSHELL_WORKER_SECURITY_MODE", existingId, "/worker/bin", command, "--instance", "adopted"]),
        ]);
        await assert.rejects(f.runtime().client.status(), /already running/u);
    });

    test(`${provider}: approval policy hot update survives runtime reconstruction with the same container identity`, async (t) => {
        const f = await fixture(t, provider);
        const updated = { ...f.instance, approvalPolicy: { mode: "ask" as const } };
        assert.equal(requiresWorkerRebuild(f.instance, updated), false);
        await f.runtime().client.start();
        const resumed = f.runtime(updated);
        assert.deepEqual(JSON.parse((await resumed.client.status()).stdout), { state: "running" });
        await resumed.client.stop();
        await resumed.client.start();
        await resumed.retirement.retire();
        assert.equal(f.container().id, existingId);
        assert.equal(f.container().status, "running");
        assert.equal(f.workerStates.get("neighbor"), "running");
        assert.deepEqual(f.calls.filter(({ args }) => args[0] === "start" || args[0] === "stop").map(({ args }) => args), [["start", existingId]]);
    });

    test(`${provider}: verified previous config ownership migrates in place before hot update and retirement`, async (t) => {
        const f = await fixture(t, provider);
        await f.runtime().client.start();
        const previous = await f.seedPreviousOwner();
        assert.deepEqual(JSON.parse((await f.runtime().client.status()).stdout), { state: "running" });
        const migrated = await f.adoption.transaction(async (transaction) => transaction.read());
        assert.ok(migrated);
        assert.notEqual(migrated.owner, previous.owner);
        assert.deepEqual({ ...migrated, owner: previous.owner }, previous);
        const updated = f.runtime({ ...f.instance, approvalPolicy: { mode: "ask" } });
        assert.deepEqual(JSON.parse((await updated.client.status()).stdout), { state: "running" });
        await updated.retirement.retire();
        assert.equal(await f.adoption.transaction(async (transaction) => transaction.read()), undefined);
        assert.equal(f.container().status, "running");
        assert.deepEqual(f.calls.filter(({ args }) => args[0] === "start" || args[0] === "stop").map(({ args }) => args), [["start", existingId]]);
    });

    test(`${provider}: previous ownership cannot migrate across a changed resource binding or start identity`, async (t) => {
        const f = await fixture(t, provider);
        await f.runtime().client.start();
        const previous = await f.seedPreviousOwner();
        const changed: ControlInstanceConfig[] = [
            { ...f.instance, name: "other-instance" },
            { ...f.instance, container: { mode: "existingStoppedContainer", containerName: existingId, adoptLifecycle: false } },
            { ...f.instance, [provider === "docker" ? "dockerBinary" : "podmanBinary"]: "/other/provider" },
            normalizeConfigInstanceDraft({ name: f.instance.name, provider: provider === "docker" ? "podman" : "docker", container: f.instance.container }),
        ];
        const beforeRefusal = f.calls.length;
        for (const config of changed) await assert.rejects(f.runtime(config).client.stop(), /already running/u);
        assert.deepEqual(await f.adoption.transaction(async (transaction) => transaction.read()), previous);
        f.replace(existingId, "2026-10-20T02:00:00Z");
        await assert.rejects(f.runtime().client.retireRuntime(), /already running/u);
        assert.equal(await f.adoption.transaction(async (transaction) => transaction.read()), undefined);
        f.replace(existingId, previous.startedAt);
        await assert.rejects(f.runtime().client.status(), /already running/u);
        assert.deepEqual(f.calls.slice(beforeRefusal).map(({ args }) => args[0]), Array(6).fill("inspect"));
        assert.equal(f.container().status, "running");
    });

    test(`${provider}: changed instance, container name, executable and backend cannot borrow adoption`, async (t) => {
        const f = await fixture(t, provider);
        await f.runtime().client.start();
        const changed: ControlInstanceConfig[] = [
            { ...f.instance, name: "other-instance" },
            { ...f.instance, container: { mode: "existingStoppedContainer", containerName: existingId, adoptLifecycle: false } },
            { ...f.instance, [provider === "docker" ? "dockerBinary" : "podmanBinary"]: "/other/provider" },
            normalizeConfigInstanceDraft({
                name: f.instance.name,
                provider: provider === "docker" ? "podman" : "docker",
                container: f.instance.container,
            }),
        ];
        const beforeRefusal = f.calls.length;
        for (const config of changed) {
            await assert.rejects(f.runtime(config).client.start(), /already running/u);
            await assert.rejects(f.runtime(config).client.stop(), /already running/u);
            await assert.rejects(f.runtime(config).client.retireRuntime(), /already running/u);
        }
        assert.deepEqual(f.calls.slice(beforeRefusal).map(({ args }) => args[0]), Array(12).fill("inspect"));
        assert.deepEqual(JSON.parse((await f.runtime().client.status()).stdout), { state: "running" });
        assert.equal(f.container().status, "running");
    });

    test(`${provider}: a stale runtime cannot stop or retire a later generation after worker-only stop`, async (t) => {
        const f = await fixture(t, provider);
        const stale = f.runtime();
        await stale.client.start();
        await stale.client.stop();
        await f.runtime().retirement.retire();
        f.container().status = "stopped";
        const current = f.runtime();
        await current.client.start();
        const beforeRefusal = f.calls.length;
        await assert.rejects(stale.client.status(), /generation changed/u);
        await assert.rejects(stale.client.stop(), /generation changed/u);
        await assert.rejects(stale.client.retireRuntime(), /generation changed/u);
        await stale.retirement.retireProviderResources();
        assert.deepEqual(f.calls.slice(beforeRefusal).map(({ args }) => args[0]), Array(3).fill("inspect"));
        assert.deepEqual(JSON.parse((await current.client.status()).stdout), { state: "running" });
        assert.equal(f.container().status, "running");
    });

    test(`${provider}: approval hot update keeps lifecycle-adopted stop and retirement behavior`, async (t) => {
        const f = await fixture(t, provider, true);
        await f.runtime().client.start();
        const resumed = f.runtime({ ...f.instance, approvalPolicy: { mode: "ask" } });
        assert.deepEqual(JSON.parse((await resumed.client.status()).stdout), { state: "running" });
        await resumed.retirement.retire();
        assert.equal(f.container().status, "stopped");
        assert.equal(f.workerStates.has("adopted"), false);
        assert.equal(f.workerStates.get("neighbor"), "running");
        assert.deepEqual(f.calls.filter(({ args }) => args[0] === "start" || args[0] === "stop").map(({ args }) => args), [
            ["start", existingId], ["stop", existingId], ["start", existingId], ["stop", existingId],
        ]);
    });

    for (const replacement of ["same-name replacement", "external restart"] as const) {
        test(`${provider}: stop without lifecycle adoption still rejects ${replacement} before worker or physical mutation`, async (t) => {
            const f = await fixture(t, provider);
            const runtime = f.runtime();
            await runtime.client.start();
            await runtime.client.stop();
            f.replace(replacement === "same-name replacement" ? replacementId : existingId, "2026-10-20T02:00:00Z");
            const beforeRefusal = f.calls.length;
            await assert.rejects(runtime.client.status(), /already running/u);
            await assert.rejects(f.runtime().client.start(), /already running/u);
            await assert.rejects(f.runtime().client.stop(), /already running/u);
            await assert.rejects(f.runtime().client.retireRuntime(), /already running/u);
            assert.deepEqual(f.calls.slice(beforeRefusal).map(({ args }) => args[0]), Array(4).fill("inspect"));
            assert.equal(f.container().status, "running");
            assert.equal(f.workerStates.get("neighbor"), "running");
        });
    }
}


for (const provider of ["docker", "podman"] as const) {
    test(`${provider}: failed native stop during full retirement retains live adoption and permits reconstructed retry`, async (t) => {
        const f = await fixture(t, provider);
        const runtime = f.runtime();
        await runtime.client.start();
        const provenance = await f.adoption.transaction(async (tx) => tx.read());
        const failure = t.mock.method(runtime.client, "stop", async () => ({ exitCode: 23, stdout: "", stderr: "transient stop failure", details: {} }));
        await assert.rejects(runtime.retirement.retire(), /incomplete/u);
        assert.deepEqual(await f.adoption.transaction(async (tx) => tx.read()), provenance);
        assert.equal(f.workerStates.get("adopted"), "running");
        failure.mock.restore();
        assert.equal((await f.runtime().client.status()).exitCode, 0);
        await f.runtime().retirement.retire();
        assert.equal(f.workerStates.has("adopted"), false);
        assert.equal(await f.adoption.transaction(async (tx) => tx.read()), undefined);
    });

    test(`${provider}: native retire failure retains adoption for retry`, async (t) => {
        const f = await fixture(t, provider);
        const runtime = f.runtime();
        await runtime.client.start();
        const failure = t.mock.method(runtime.client, "retireRuntime", async () => ({ exitCode: 29, stdout: "", stderr: "transient retire failure", details: {} }));
        await assert.rejects(runtime.retirement.retire(), /incomplete/u);
        assert.ok(await f.adoption.transaction(async (tx) => tx.read()));
        failure.mock.restore();
        await f.runtime().retirement.retire();
        assert.equal(f.workerStates.has("adopted"), false);
        assert.equal(await f.adoption.transaction(async (tx) => tx.read()), undefined);
    });

    test(`${provider}: fresh skipRuntime retirement revokes the predecessor adoption`, async (t) => {
        const f = await fixture(t, provider);
        await f.runtime().client.start();
        await f.runtime().retirement.retire(true);
        assert.equal(await f.adoption.transaction(async (tx) => tx.read()), undefined);
        await assert.rejects(f.runtime().client.status(), /already running/u);
        assert.equal(f.container().status, "running");
        assert.equal(f.workerStates.get("neighbor"), "running");
    });

    test(`${provider}: stopped physical container native stale PID is stopped after temporary start before retirement`, async (t) => {
        const f = await fixture(t, provider, true);
        f.workerStates.set("adopted", "stale");
        await f.runtime().retirement.retire();
        assert.equal(f.workerStates.has("adopted"), false);
        assert.equal(f.container().status, "stopped");
        assert.deepEqual(f.calls.filter(({ args }) => args[0] === "exec").map(({ args }) => args[args.indexOf("/worker/bin") + 1]), ["stop", "retire"]);
        assert.equal(f.workerStates.get("neighbor"), "running");
    });
}


for (const provider of ["docker", "podman"] as const) {
    test(`${provider}: persisted binding migrates old full-config owner after policy changes before the first read`, async (t) => {
        const f = await fixture(t, provider);
        await f.runtime().client.start();
        const previous = await f.seedPreviousOwner(true);
        const changed = f.runtime({ ...f.instance, approvalPolicy: { mode: "ask" } });
        assert.deepEqual(JSON.parse((await changed.client.status()).stdout), { state: "running" });
        const migrated = await f.adoption.transaction(async (tx) => tx.read());
        assert.ok(migrated);
        assert.notEqual(migrated.owner, previous.owner);
        assert.equal(migrated.generation, previous.generation);
        assert.equal(migrated.containerId, previous.containerId);
        assert.equal(migrated.startedAt, previous.startedAt);
        await changed.retirement.retire();
        assert.equal(await f.adoption.transaction(async (tx) => tx.read()), undefined);
        assert.equal(f.workerStates.get("neighbor"), "running");
    });

    test(`${provider}: opaque legacy full-config hash without binding evidence cannot authorize changed configuration`, async (t) => {
        const f = await fixture(t, provider);
        await f.runtime().client.start();
        const previous = await f.seedPreviousOwner();
        await assert.rejects(f.runtime({ ...f.instance, approvalPolicy: { mode: "ask" } }).client.status(), /already running/u);
        assert.deepEqual(await f.adoption.transaction(async (tx) => tx.read()), previous);
        assert.equal(f.container().status, "running");
    });
}
