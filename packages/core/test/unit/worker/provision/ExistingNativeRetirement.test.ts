import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ContainerExecution } from "../../../../src/instance/runtime/execution/provider/Container.ts";
import { WorkerCommandClient } from "../../../../src/instance/runtime/execution/Command.ts";
import { WorkerBinary } from "../../../../src/instance/runtime/Binary.ts";
import { ContainerInstall } from "../../../../src/instance/runtime/provision/install/provider/Container.ts";
import { ContainerAdoptionStore } from "../../../../src/instance/runtime/provision/container/Adoption.ts";
import { WorkerInstanceRetirement } from "../../../../src/instance/runtime/provision/Retirement.ts";
import { realWorkerTestOptions, resolveTestWorkerBinary } from "../../../../../../test/TestPlatformSupport.ts";
import { existingId, startedAt } from "./ExistingHarness.ts";

const worker = resolveTestWorkerBinary();
const options = process.platform === "win32" ? { skip: "requires POSIX provider fixture" } : realWorkerTestOptions(worker);

test("Existing native retirement: stopped Mock Podman container clears actual Rust stale PID before retirement", options, async (t) => {
    assert.ok(worker);
    const root = await mkdtemp(join(tmpdir(), "existing-native-retirement-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, "fake-provider.mjs");
    await writeFile(binary, `#!${process.execPath}\n${await readFile(new URL("./ExistingCli.mjs", import.meta.url), "utf8")}`, { mode: 0o755 });
    await mkdir(join(root, "container-home"));
    await writeFile(join(root, "containers.json"), JSON.stringify({
        configured: { Id: existingId, State: { Status: "stopped", StartedAt: startedAt } },
        neighbor: { Id: "c".repeat(64), State: { Status: "running", StartedAt: startedAt } },
    }));
    const name = "adopted-stale";
    const stateRoot = join(root, "worker-state");
    const instanceRoot = join(stateRoot, name);
    await mkdir(join(instanceRoot, "state"), { recursive: true });
    await writeFile(join(instanceRoot, "state", "worker.pid"), "invalid-test-pid\n");
    await mkdir(join(instanceRoot, "artifacts"));
    await writeFile(join(instanceRoot, "artifacts", "retained.txt"), "retained until native stop succeeds");
    const adoption = { databaseFile: join(root, "adoption.sqlite3"), owner: name, resourceDirectory: join(root, "resources") };
    const env = { PORTABLE_DEVSHELL_HOME: stateRoot };
    const runtime = new ContainerExecution(new ContainerInstall({
        adoption, binary, provider: "podman", workerBinary: new WorkerBinary(worker),
        container: { mode: "existingStoppedContainer", containerName: "configured", adoptLifecycle: true },
    }));
    const client = new WorkerCommandClient(runtime, name, env);
    // Establish that the prepared native Worker really rejects this residue.
    const before = await client.retireRuntime();
    assert.equal(before.exitCode, 1, JSON.stringify(before));
    assert.match(before.stderr, /has stale daemon state; stop it before retirement/u);
    assert.equal(await readFile(join(instanceRoot, "artifacts", "retained.txt"), "utf8"), "retained until native stop succeeds");
    const retirement = new WorkerInstanceRetirement({ config: { name, preserveProviderOnRuntimeRetirementFailure: true } as never, commandClient: client });
    await retirement.retire();
    await assert.rejects(readFile(join(instanceRoot, "state", "worker.pid")), { code: "ENOENT" });
    await assert.rejects(readFile(join(instanceRoot, "artifacts", "retained.txt")), { code: "ENOENT" });
    const states = JSON.parse(await readFile(join(root, "containers.json"), "utf8"));
    assert.equal(states.configured.State.Status, "stopped");
    assert.equal(states.neighbor.State.Status, "running");
    const calls: string[][] = (await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls.filter(([operation]) => operation === "exec").map((args) => args[args.indexOf(worker) + 1]), ["retire", "stop", "retire"]);
    assert.equal(await new ContainerAdoptionStore(adoption.databaseFile).transaction(async (tx) => tx.read()), undefined);
});
