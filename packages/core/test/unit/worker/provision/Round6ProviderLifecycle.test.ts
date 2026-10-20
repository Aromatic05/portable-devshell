import assert from "node:assert/strict";
import { access, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { RemoteError, runtimeErrorCodes } from "@portable-devshell/shared";
import { providerFixture } from "./Round6ProviderHarness.ts";

function errorDetails(error: RemoteError): Record<string, unknown> {
    assert.ok(error.details !== null && typeof error.details === "object" && !Array.isArray(error.details));
    return error.details as Record<string, unknown>;
}

const posix = { skip: process.platform === "win32" ? "requires POSIX executable fixtures" : false };

test("Round6 provider: interleaved starts and deletion keep two container identities isolated", posix, async (t) => {
    const f = await providerFixture(t);
    const alpha = f.managed("alpha");
    const beta = f.managed("beta");
    await f.faults([{ operation: "create", name: "alpha", gate: true }]);
    const startingAlpha = alpha.install.ensureReady("start");
    // Attach the rejection handler immediately even if gate setup fails.
    const alphaOutcome = Promise.allSettled([startingAlpha]);
    try {
        await f.waitForGate();
        await beta.install.ensureReady("start");
        assert.equal((await f.states()).beta?.status, "running");
        assert.equal((await f.states()).alpha, undefined);
    } finally {
        await f.releaseGate();
        assert.deepEqual(await alphaOutcome, [{ status: "fulfilled", value: undefined }]);
    }
    await beta.install.retireProviderResources();
    assert.deepEqual(Object.keys(await f.states()), ["alpha"]);
    assert.equal(await alpha.install.isAvailable(), true);
    assert.equal(await beta.install.isAvailable(), false);
});

test("Round6 provider: implicit image-pull timeout leaves no instance and retry creates a usable worker", posix, async (t) => {
    const f = await providerFixture(t);
    const { install, execution } = f.managed("pull-timeout");
    // Podman create performs implicit pull; the boundary reports its timeout.
    await f.faults([{ operation: "create", code: 124, message: "image pull deadline exceeded" }]);
    await assert.rejects(install.ensureReady("start"), (error: unknown) => {
        assert.ok(error instanceof RemoteError);
        assert.equal(error.code, runtimeErrorCodes.providerFailed);
        assert.equal(errorDetails(error).exitCode, 124);
        assert.equal(errorDetails(error).operation, "createContainer");
        assert.match(String(errorDetails(error).stderrTail), /image pull deadline/u);
        return true;
    });
    assert.deepEqual(await f.states(), {});
    const result = await execution.runWorkerCommand("start", { instanceName: "pull-timeout" });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout).args, ["start", "--instance", "pull-timeout"]);
    assert.equal((await f.states())["pull-timeout"]?.status, "running");
});

test("Round6 provider: terminated create propagates SIGTERM and later start is not poisoned", posix, async (t) => {
    const f = await providerFixture(t);
    const { install } = f.managed("cancel-pull");
    await f.faults([{ operation: "create", signal: "SIGTERM" }]);
    await assert.rejects(install.ensureReady("start"), (error: unknown) => {
        assert.ok(error instanceof RemoteError);
        assert.equal(errorDetails(error).signal, "SIGTERM");
        assert.equal(errorDetails(error).exitCode, null);
        return true;
    });
    assert.deepEqual(await f.states(), {});
    assert.equal((await f.calls()).some((call) => call.operation === "start"), false);
    await install.ensureReady("start");
    assert.equal(await install.isAvailable(), true);
});

test("Round6 provider: permanent image denial never starts a partial or unrelated instance", posix, async (t) => {
    const f = await providerFixture(t);
    await f.seed({ neighbor: { status: "running", args: [] } });
    const { install } = f.managed("denied");
    await f.faults(Array.from({ length: 2 }, () => ({ operation: "create", code: 125, message: "registry access denied" })));
    for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(install.ensureReady("start"), (error: unknown) => {
            assert.ok(error instanceof RemoteError);
            assert.equal(errorDetails(error).provider, "podman");
            assert.equal(errorDetails(error).exitCode, 125);
            assert.match(String(errorDetails(error).stderrTail), /registry access denied/u);
            return true;
        });
    }
    await install.retireProviderResources();
    assert.deepEqual(await f.states(), { neighbor: { status: "running", args: [] } });
    assert.deepEqual((await f.calls()).filter((call) => ["start", "rm"].includes(call.operation)), []);
});

test("Round6 provider: failed first start retains created container and retry resumes without duplicate create", posix, async (t) => {
    const f = await providerFixture(t);
    const { install, execution } = f.managed("start-retry");
    await f.faults([{ operation: "start", code: 125, message: "temporary cgroup allocation failure" }]);
    await assert.rejects(install.ensureReady("start"), (error: unknown) => {
        assert.ok(error instanceof RemoteError);
        assert.equal(errorDetails(error).operation, "startContainer");
        return true;
    });
    assert.equal((await f.states())["start-retry"]?.status, "stopped");
    const result = await execution.runWorkerCommand("start", { instanceName: "start-retry" });
    assert.equal(result.exitCode, 0);
    assert.equal((await f.calls()).filter((call) => call.operation === "create").length, 1);
    assert.equal((await f.calls()).filter((call) => call.operation === "start").length, 2);
});

test("Round6 provider: storage inspection failure is never misclassified as missing during deletion", posix, async (t) => {
    const f = await providerFixture(t);
    const { install } = f.managed("inspect-denied");
    await install.ensureReady("start");
    await f.faults([{ operation: "inspect", code: 125, message: "permission denied opening isolated storage" }]);
    await assert.rejects(install.retireProviderResources(), (error: unknown) => {
        assert.ok(error instanceof RemoteError);
        assert.equal(errorDetails(error).operation, "inspectContainer");
        assert.match(String(errorDetails(error).stderrTail), /permission denied/u);
        return true;
    });
    assert.equal((await f.states())["inspect-denied"]?.status, "running");
    assert.equal((await f.calls()).filter((call) => call.operation === "rm").length, 0);
    await install.retireProviderResources();
    assert.deepEqual(await f.states(), {});
});

test("Round6 provider: busy deletion retries once, preserves sibling, and subsequent deletion is idempotent", posix, async (t) => {
    const f = await providerFixture(t);
    const { install } = f.managed("busy-delete");
    await f.seed({ sibling: { status: "running", args: ["preserved"] } });
    await install.ensureReady("start");
    await f.faults([{ operation: "rm", code: 125, message: "container storage busy" }]);
    await assert.rejects(install.retireProviderResources(), (error: unknown) => {
        assert.ok(error instanceof RemoteError);
        assert.equal(errorDetails(error).operation, "removeContainer");
        return true;
    });
    assert.equal((await f.states())["busy-delete"]?.status, "running");
    await install.retireProviderResources();
    await install.retireProviderResources();
    assert.deepEqual(await f.states(), { sibling: { status: "running", args: ["preserved"] } });
    assert.deepEqual((await f.calls()).filter((call) => call.operation === "rm").map((call) => call.args), [
        ["rm", "-f", "busy-delete"], ["rm", "-f", "busy-delete"],
    ]);
});

test("Round6 provider: reconstructed managed runtime uses existing worker then resumes after stop", posix, async (t) => {
    const f = await providerFixture(t);
    await f.managed("resumed").install.ensureReady("start");
    const resumed = f.managed("resumed");
    const status = await resumed.execution.runWorkerCommand("status", { instanceName: "resumed" });
    assert.equal(status.exitCode, 0);
    assert.deepEqual(JSON.parse(status.stdout).args, ["status", "--instance", "resumed"]);
    const stopped = await resumed.execution.runWorkerCommand("stop", { instanceName: "resumed" });
    assert.equal(stopped.exitCode, 0);
    assert.equal((await f.states()).resumed?.status, "stopped");
    const restarted = await f.managed("resumed").execution.runWorkerCommand("start", { instanceName: "resumed" });
    assert.equal(restarted.exitCode, 0);
    assert.equal((await f.states()).resumed?.status, "running");
    assert.equal((await f.calls()).filter((call) => call.operation === "create").length, 1);
});

test("Round6 provider: stopped runtime queries do not execute workers or recreate resources", posix, async (t) => {
    const f = await providerFixture(t);
    await f.seed({ stopped: { status: "stopped", args: ["original"] } });
    const { execution } = f.managed("stopped");
    const status = await execution.runWorkerCommand("status", { instanceName: "stopped" });
    const logs = await execution.runWorkerCommand("logs", { instanceName: "stopped" });
    const stop = await execution.runWorkerCommand("stop", { instanceName: "stopped" });
    const retire = await execution.runWorkerCommand("retire", { instanceName: "stopped" });
    assert.deepEqual([status.exitCode, logs.exitCode, stop.exitCode, retire.exitCode], [0, 0, 0, 0]);
    assert.deepEqual(JSON.parse(status.stdout), { state: "stopped" });
    assert.equal(logs.stdout, "");
    assert.deepEqual(JSON.parse(stop.stdout), { stopped: true });
    assert.deepEqual(JSON.parse(retire.stdout), { retired: false });
    assert.deepEqual(await f.states(), { stopped: { status: "stopped", args: ["original"] } });
    assert.deepEqual((await f.calls()).map((call) => call.operation), ["inspect", "inspect", "inspect", "inspect"]);
});

test("Round6 provider: worker stop failure leaves container running until successful retry", posix, async (t) => {
    const f = await providerFixture(t);
    const { execution } = f.managed("worker-stop");
    assert.equal((await execution.runWorkerCommand("start", { instanceName: "worker-stop" })).exitCode, 0);
    const failure = await execution.runWorkerCommand("stop", { instanceName: "worker-stop", env: { ROUND6_EXIT: "37" } });
    assert.equal(failure.exitCode, 37);
    assert.equal((await f.states())["worker-stop"]?.status, "running");
    assert.equal((await f.calls()).filter((call) => call.operation === "stop").length, 0);
    assert.equal((await execution.runWorkerCommand("stop", { instanceName: "worker-stop" })).exitCode, 0);
    assert.equal((await f.states())["worker-stop"]?.status, "stopped");
});

test("Round6 provider: create and exec preserve hostile argv and environment without shell evaluation", posix, async (t) => {
    const f = await providerFixture(t);
    const marker = join(f.root, "injected");
    const hostile = `spaces ' \" ; $(touch ${marker})\nsecond line`;
    const source = join(f.root, "mount with ' and spaces");
    const { install, execution } = f.managed("safe-args", {
        env: { ROUND6_VALUE: hostile },
        mounts: [{ source, target: "/fixture path", mode: "ro", selinux: "private" }],
    });
    await install.ensureReady("start");
    const create = (await f.states())["safe-args"]!.args;
    assert.equal(create[create.indexOf("-e") + 1], `ROUND6_VALUE=${hostile}`);
    assert.equal(create[create.indexOf("-v") + 1], `${source}:/fixture path:ro:Z`);
    assert.equal(create.includes("--userns=keep-id"), true);
    const result = await execution.runWorkerCommand("start", {
        instanceName: "safe-args", extraArgs: [hostile, ""],
        env: { ROUND6_VALUE: hostile, DEVSHELL_WORKER_INTERNAL_INSTANCE: "must-not-forward" },
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { args: ["start", "--instance", "safe-args", hostile, ""], value: hostile });
    const worker = (await f.calls()).find((call) => call.operation === "worker")!;
    assert.deepEqual(worker.keys, ["ROUND6_VALUE"]);
    await assert.rejects(access(marker), { code: "ENOENT" });
});

test("Round6 SSH: real shell round-trips adversarial argv, env and stdin then removes env staging", posix, async (t) => {
    const f = await providerFixture(t);
    const connection = f.ssh();
    const marker = join(f.root, "ssh-injected");
    const hostile = `a ' \" $HOME $(touch ${marker});\nnext`;
    const script = 'const fs=require("node:fs"); const input=fs.readFileSync(0,"utf8"); fs.writeSync(1,JSON.stringify({args:process.argv.slice(1),value:process.env.ROUND6_VALUE,input,internal:process.env.DEVSHELL_WORKER_INTERNAL_INSTANCE}));';
    const result = await connection.runCommand("roundtrip", [process.execPath, "-e", script, "--", hostile, ""], {
        env: { ROUND6_VALUE: hostile, DEVSHELL_WORKER_INTERNAL_INSTANCE: "private" },
        input: Buffer.from("binary\0input\n"),
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args: [hostile, ""], value: hostile, input: "binary\0input\n" });
    assert.deepEqual(await f.remoteTemps(), []);
    await assert.rejects(access(marker), { code: "ENOENT" });
    const calls = await f.calls();
    assert.equal(calls.length, 2);
});

test("Round6 SSH: corrupted upload cleans partial files and shared enroll retry succeeds", posix, async (t) => {
    const f = await providerFixture(t);
    const connection = f.ssh();
    const { installer, sha256, target } = await f.installer(connection);
    await f.faults([{ operation: "ssh", contains: "tmp_binary_path=", corruptUpload: true }]);
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => installer.ensure("devshell-worker")));
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["rejected", "rejected", "rejected", "rejected"]);
    for (const attempt of attempts) {
        assert.equal(attempt.status, "rejected");
        const error = (attempt as PromiseRejectedResult).reason as unknown;
        assert.ok(error instanceof RemoteError);
        assert.equal(error.code, runtimeErrorCodes.workerProvisionFailed);
        assert.equal(errorDetails(error).exitCode, 1);
        assert.match(String(errorDetails(error).stderrTail), /worker bundle checksum mismatch/u);
    }
    const alias = join(f.root, "remote-home", ".devshell", "bin", "devshell-worker");
    await assert.rejects(access(alias), { code: "ENOENT" });
    const generation = join(f.root, "remote-home", ".devshell", "workers", target.key, sha256);
    assert.deepEqual(await readdir(generation), [], "failed checksum leaves no binary, digest or temporary upload");
    assert.deepEqual(await readdir(join(f.root, "remote-home", ".devshell", "bin")), []);
    assert.equal((await f.calls()).filter((call) => call.args.join(" ").includes("tmp_binary_path=")).length, 1);
    const paths = await Promise.all(Array.from({ length: 4 }, () => installer.ensure("devshell-worker")));
    assert.deepEqual(paths, [alias, alias, alias, alias]);
    assert.equal(await readlink(alias), `../workers/${target.key}/${sha256}/devshell-worker`);
    assert.deepEqual(await readFile(alias), await readFile(f.worker));
    assert.deepEqual(await readdir(join(f.root, "remote-home", ".devshell", "workers", target.key, sha256)), ["devshell-worker", "devshell-worker.sha256"]);
    assert.equal((await f.calls()).filter((call) => call.args.join(" ").includes("tmp_binary_path=")).length, 2);
    const result = await connection.runCommand("installedWorker", [alias, "--version"]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout).args, ["--version"]);
});

test("Round6 SSH: permanent authentication failure retains diagnostics and never creates installation state", posix, async (t) => {
    const f = await providerFixture(t);
    const { installer } = await f.installer(f.ssh());
    await f.faults(Array.from({ length: 2 }, () => ({ operation: "ssh", code: 255, message: "Permission denied (publickey)." })));
    for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(installer.ensure("devshell-worker"), (error: unknown) => {
            assert.ok(error instanceof RemoteError);
            assert.equal(error.code, runtimeErrorCodes.workerTargetProbeFailed);
            assert.equal(errorDetails(error).exitCode, 255);
            assert.equal(errorDetails(error).provider, "ssh");
            assert.match(String(errorDetails(error).stderrTail), /requires interactive authentication/u);
            return true;
        });
    }
    assert.deepEqual(await readdir(join(f.root, "remote-home")), []);
    assert.deepEqual(await f.remoteTemps(), []);
    assert.equal((await f.calls()).length, 2);
});

test("Round6 SSH: concurrent failed and successful commands isolate env files and a retry uses fresh env", posix, async (t) => {
    const f = await providerFixture(t);
    const connection = f.ssh();
    const script = 'require("node:fs").writeSync(1,process.env.ROUND6_VALUE); process.exit(Number(process.argv[1]));';
    const [failed, success] = await Promise.all([
        connection.runCommand("failed", [process.execPath, "-e", script, "23"], { env: { ROUND6_VALUE: "failed-value" } }),
        connection.runCommand("success", [process.execPath, "-e", script, "0"], { env: { ROUND6_VALUE: "success-value" } }),
    ]);
    assert.equal(failed.exitCode, 23);
    assert.equal(failed.stdout.trim(), "failed-value");
    assert.equal(success.exitCode, 0);
    assert.equal(success.stdout.trim(), "success-value");
    assert.deepEqual(await f.remoteTemps(), []);
    const retry = await connection.runCommand("retry", [process.execPath, "-e", script, "0"], { env: { ROUND6_VALUE: "fresh-value" } });
    assert.equal(retry.exitCode, 0);
    assert.equal(retry.stdout.trim(), "fresh-value");
    assert.deepEqual(await f.remoteTemps(), []);
});
