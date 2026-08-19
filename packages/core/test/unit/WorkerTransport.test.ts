import assert from "node:assert/strict";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, readlink, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { extract } from "tar-stream";

import {
    createContainerWorkerEnvironment,
    WorkerTransportDriverDocker,
    WorkerTransportDriverLocal,
    WorkerTransportDriverPodman,
    WorkerInstallerRemote,
    createWorkerSkillArchive,
    WorkerTransportDriverSsh,
    WorkerBinary,
    getWorkerTargetByKey,
    probeLocalWorkerTarget
} from "@portable-devshell/core/testing";
import { createError, errorCodes } from "@portable-devshell/shared";
import { realWorkerTestOptions, resolveTestWorkerBinary } from "../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const workerBinaryPath = resolveTestWorkerBinary();
const NO_SKILLS_DIRECTORY = join(tmpdir(), `portable-devshell-no-skills-${randomUUID()}`);

const shellEscape = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

function sanitizedWorkerEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.DEVSHELL_WORKER_INTERNAL_INSTANCE;
    delete env.DEVSHELL_WORKER_INTERNAL_WORKSPACE;
    delete env.DEVSHELL_WORKER_INTERNAL_SECURITY_MODE;
    return env;
}

test("local transport builds start command and rpc bridge", async () => {
    const recorder = createSpawnRecorder();
    const transport = new WorkerTransportDriverLocal({
        workerBinary: new WorkerBinary("/worker/bin"),
        spawnFunction: recorder.spawn
    });

    const startResult = await transport.runWorkerCommand("start", {
        instanceName: "task-3-local",
    });

    assert.equal(startResult.exitCode, 0);
    assert.equal(recorder.calls[0]?.command, "/worker/bin");
    assert.deepEqual(recorder.calls[0]?.args, ["start", "--instance", "task-3-local"]);
    assert.equal(recorder.calls[0]?.options.cwd, undefined);
    assert.deepEqual(recorder.calls[0]?.options.env, sanitizedWorkerEnv());
    assert.deepEqual(recorder.calls[0]?.options.stdio, ["ignore", "pipe", "pipe"]);

    const rpcProcess = await transport.spawnWorkerRpc({ instanceName: "task-3-local" });

    assert.equal(rpcProcess.stdin, recorder.children[1].stdin);
    assert.equal(rpcProcess.stdout, recorder.children[1].stdout);
    assert.equal(rpcProcess.stderr, recorder.children[1].stderr);
    assert.equal(rpcProcess.kill("SIGTERM"), true);
    assert.deepEqual(await rpcProcess.exit, { code: null, signal: "SIGTERM" });
    assert.equal(recorder.calls[1]?.command, "/worker/bin");
    assert.deepEqual(recorder.calls[1]?.args, ["rpc", "--instance", "task-3-local"]);
    assert.equal(recorder.calls[1]?.options.cwd, undefined);
    assert.deepEqual(recorder.calls[1]?.options.env, sanitizedWorkerEnv());
    assert.deepEqual(recorder.calls[1]?.options.stdio, ["pipe", "pipe", "pipe"]);
});

test("local transport runs installWorker probe", async () => {
    const recorder = createSpawnRecorder();
    const transport = new WorkerTransportDriverLocal({
        workerBinary: new WorkerBinary("/worker/bin"),
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();

    assert.deepEqual(recorder.calls[0], {
        command: "/worker/bin",
        args: ["--version"],
        options: { cwd: undefined, env: sanitizedWorkerEnv(), stdio: ["ignore", "pipe", "pipe"] }
    });
});

test("local transport honors command PORTABLE_DEVSHELL_HOME for worker lookup and installation", async (t) => {
    const root = await createTestTempDirectory("custom-home");
    const devshellHome = join(root, "custom-devshell-home");
    const worker = await createDummyWorkerBinary("custom-home");
    t.after(async () => {
        await worker.cleanup();
        await rm(root, { recursive: true, force: true });
    });

    const target = probeLocalWorkerTarget();
    const workerPathEnvironmentName = `PORTABLE_DEVSHELL_WORKER_${target.key.replaceAll("-", "_").toUpperCase()}_PATH`;
    const recorder = createSpawnRecorder();
    const transport = new WorkerTransportDriverLocal({ spawnFunction: recorder.spawn });
    const result = await transport.runWorkerCommand("status", {
        env: {
            PORTABLE_DEVSHELL_HOME: devshellHome,
            [workerPathEnvironmentName]: worker.path
        },
        instanceName: "custom-home-local"
    });

    assert.equal(result.exitCode, 0);
    const workerSha = createHash("sha256").update(worker.contents).digest("hex");
    const targetAlias = join(devshellHome, "bin", `devshell-worker-${target.key}${target.os === "windows" ? ".exe" : ""}`);
    const executedWorker = recorder.calls[0]?.command;
    assert.equal(typeof executedWorker, "string");
    assert.equal(
        createHash("sha256").update(await readFile(executedWorker!)).digest("hex"),
        workerSha
    );
    assert.equal(await installedWorkerSha(targetAlias), workerSha);
});

test("local start upgrades a changed worker while status keeps the active worker stable", async (t) => {
    const root = await createTestTempDirectory("local-upgrade");
    const devshellHome = join(root, "devshell-home");
    const oldWorker = await createDummyWorkerBinary("old");
    const newWorker = await createDummyWorkerBinary("new");
    t.after(async () => {
        await oldWorker.cleanup();
        await newWorker.cleanup();
        await rm(root, { recursive: true, force: true });
    });

    const target = probeLocalWorkerTarget();
    const workerPathEnvironmentName = `PORTABLE_DEVSHELL_WORKER_${target.key.replaceAll("-", "_").toUpperCase()}_PATH`;
    const oldSha = createHash("sha256").update(oldWorker.contents).digest("hex");
    const newSha = createHash("sha256").update(newWorker.contents).digest("hex");
    let daemonSha = oldSha;
    const recorder = createSpawnRecorder((call, child) => {
        if (call.args[0] !== "status") {
            return false;
        }
        closeRecordedChild(child, {
            stdout: JSON.stringify({ state: "running", workerSha256: daemonSha, workspace: "/tmp/workspace" })
        });
        return true;
    });
    const transport = new WorkerTransportDriverLocal({ spawnFunction: recorder.spawn });
    const baseOptions = {
        instanceName: "local-upgrade",
    };
    const oldEnv = {
        PORTABLE_DEVSHELL_HOME: devshellHome,
        [workerPathEnvironmentName]: oldWorker.path
    };
    const newEnv = {
        PORTABLE_DEVSHELL_HOME: devshellHome,
        [workerPathEnvironmentName]: newWorker.path
    };

    await transport.runWorkerCommand("status", { ...baseOptions, env: oldEnv });
    const targetAlias = join(devshellHome, "bin", `devshell-worker-${target.key}${target.os === "windows" ? ".exe" : ""}`);
    assert.equal(await installedWorkerSha(targetAlias), oldSha);

    recorder.calls.length = 0;
    await transport.runWorkerCommand("status", { ...baseOptions, env: newEnv });
    assert.deepEqual(recorder.calls.map((call) => call.args[0]), ["status"]);
    assert.equal(await installedWorkerSha(targetAlias), oldSha);

    recorder.calls.length = 0;
    await transport.runWorkerCommand("start", { ...baseOptions, env: newEnv });
    assert.deepEqual(recorder.calls.map((call) => call.args[0]), ["status", "stop", "start"]);
    assert.equal(await installedWorkerSha(targetAlias), newSha);

    recorder.calls.length = 0;
    await transport.runWorkerCommand("start", { ...baseOptions, env: newEnv });
    assert.deepEqual(recorder.calls.map((call) => call.args[0]), ["status", "stop", "start"]);

    daemonSha = newSha;
    recorder.calls.length = 0;
    await transport.runWorkerCommand("start", { ...baseOptions, env: newEnv });
    assert.deepEqual(recorder.calls.map((call) => call.args[0]), ["status", "start"]);
});

test("provider installWorker failures keep diagnostic details across local ssh docker and podman", async () => {
    const cases = [
        {
            build: (spawnFunction: SpawnFunctionLike) =>
                new WorkerTransportDriverLocal({
                    workerBinary: new WorkerBinary("/worker/bin"),
                    spawnFunction
                }),
            expectedCommandPart: "/worker/bin",
            provider: "local"
        },
        {
            build: (spawnFunction: SpawnFunctionLike) =>
                new WorkerTransportDriverSsh({
                    command: "ssh-bin devbox",
                    skillsDirectory: NO_SKILLS_DIRECTORY,
                    workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
                    spawnFunction
                }),
            expectedCommandPart: "ssh-bin",
            provider: "ssh"
        },
        {
            build: (spawnFunction: SpawnFunctionLike) =>
                new WorkerTransportDriverDocker({
                    container: createManagedContainerConfig(),
                    dockerBinary: "docker-bin",
                    skillsDirectory: NO_SKILLS_DIRECTORY,
                    workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
                    spawnFunction
                }),
            expectedCommandPart: "/usr/local/bin/devshell-worker",
            provider: "docker"
        },
        {
            build: (spawnFunction: SpawnFunctionLike) =>
                new WorkerTransportDriverPodman({
                    container: createManagedContainerConfig(),
                    podmanBinary: "podman-bin",
                    skillsDirectory: NO_SKILLS_DIRECTORY,
                    workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
                    spawnFunction
                }),
            expectedCommandPart: "/usr/local/bin/devshell-worker",
            provider: "podman"
        }
    ] as const;

    for (const testCase of cases) {
        const recorder = createSpawnRecorder((_call, child, callIndex) => {
            if ((testCase.provider === "docker" || testCase.provider === "podman") && callIndex === 0) {
                closeRecordedChild(child, { stdout: "running\n" });
                return true;
            }

            closeRecordedChild(child, {
                code: 23,
                stderr: "fatal stderr\n",
                stdout: "fatal stdout\n"
            });
            return true;
        });
        const transport = testCase.build(recorder.spawn);

        await assert.rejects(transport.installWorker(), (error: unknown) => {
            assert.ok(typeof error === "object" && error !== null);
            assert.equal((error as { code?: string }).code, "core.workerProvisionFailed");

            const details = (error as { details?: Record<string, unknown> }).details;
            assert.equal(details?.provider, testCase.provider);
            assert.equal(details?.operation, "installWorker");
            assert.equal(details?.exitCode, 23);
            assert.equal(details?.stderrTail, "fatal stderr\n");
            assert.equal(details?.stdoutTail, "fatal stdout\n");
            assert.equal(details?.causeMessage, "fatal stderr\n");
            assert.match(String(details?.commandDisplay ?? ""), new RegExp(testCase.expectedCommandPart.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
            return true;
        });
    }
});

test("local transport preserves base process env when instance env is provided", async () => {
    const recorder = createSpawnRecorder();
    const transport = new WorkerTransportDriverLocal({
        workerBinary: new WorkerBinary("/worker/bin"),
        spawnFunction: recorder.spawn
    });
    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    const previousXdgRuntimeDir = process.env.XDG_RUNTIME_DIR;

    process.env.PATH = "/base/path";
    process.env.HOME = "/base/home";
    process.env.XDG_RUNTIME_DIR = "/base/runtime";
    const expectedEnv = {
        ...sanitizedWorkerEnv(),
        FOO: "bar"
    };

    try {
        await transport.runWorkerCommand("start", {
            env: { FOO: "bar" },
            instanceName: "task-3-local",
        });
    } finally {
        restoreEnv("PATH", previousPath);
        restoreEnv("HOME", previousHome);
        restoreEnv("XDG_RUNTIME_DIR", previousXdgRuntimeDir);
    }

    assert.deepEqual(recorder.calls[0], {
        command: "/worker/bin",
        args: ["start", "--instance", "task-3-local"],
        options: {
            cwd: undefined,
            env: expectedEnv,
            stdio: ["ignore", "pipe", "pipe"]
        }
    });
});

test("ssh transport starts the worker without a workspace cwd", async () => {
    const recorder = createSpawnRecorder();
    const transport = new WorkerTransportDriverSsh({
        command: "ssh-bin devbox",
        skillsDirectory: NO_SKILLS_DIRECTORY,
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("start", {
        instanceName: "task-3-ssh",
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(recorder.calls[0], {
        command: "ssh-bin",
        args: [
            "-oBatchMode=yes",
            "-oNumberOfPasswordPrompts=0",
            "-oKbdInteractiveAuthentication=no",
            "-oPasswordAuthentication=no",
            "devbox",
            "--",
            "sh",
            "-lc",
            shellEscape("'/usr/local/bin/devshell-worker' 'start' '--instance' 'task-3-ssh'")
        ],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(result.details, {
        command: [
            "ssh-bin",
            "-oBatchMode=yes",
            "-oNumberOfPasswordPrompts=0",
            "-oKbdInteractiveAuthentication=no",
            "-oPasswordAuthentication=no",
            "devbox",
            "--",
            "sh",
            "-lc",
            shellEscape("'/usr/local/bin/devshell-worker' 'start' '--instance' 'task-3-ssh'")
        ],
        commandDisplay:
            `ssh-bin -oBatchMode=yes -oNumberOfPasswordPrompts=0 -oKbdInteractiveAuthentication=no -oPasswordAuthentication=no devbox -- sh -lc ` +
            shellEscape("'/usr/local/bin/devshell-worker' 'start' '--instance' 'task-3-ssh'"),
        exitCode: 0,
        instance: "task-3-ssh",
        operation: "start",
        provider: "ssh"
    });
});

test("ssh transport uploads instance environment without replacing the local ssh environment", async () => {
    const recorder = createSpawnRecorder((call, child, callIndex) => {
        if (callIndex === 0) {
            child.stdin.once("finish", () => closeRecordedChild(child));
            return true;
        }
        return false;
    });
    const transport = new WorkerTransportDriverSsh({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        command: "ssh-bin devbox",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("start", {
        env: {
            API_TOKEN: "remote-secret",
            DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: "workspace",
            DEVSHELL_WORKER_SECURITY_MODE: "workspace",
            HOME: "/remote/home",
            PATH: "/remote/bin"
        },
        instanceName: "task-3-ssh",
    });

    assert.equal(result.exitCode, 0);
    assert.equal(recorder.calls.length, 2);
    const upload = recorder.calls[0];
    const start = recorder.calls[1];
    assert.ok(upload);
    assert.ok(start);
    assert.equal(upload.command, "ssh-bin");
    assert.equal(upload.options.env, undefined);
    assert.deepEqual(upload.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.match(upload.args.at(-1) ?? "", /umask 077; cat > .*portable-devshell-env-/u);
    const uploaded = Buffer.concat(recorder.children[0]?.stdinChunks ?? []).toString("utf8");
    assert.match(uploaded, /API_TOKEN='remote-secret'/u);
    assert.match(uploaded, /DEVSHELL_WORKER_SECURITY_MODE='workspace'/u);
    assert.match(uploaded, /HOME='\/remote\/home'/u);
    assert.match(uploaded, /PATH='\/remote\/bin'/u);
    assert.doesNotMatch(uploaded, /DEVSHELL_WORKER_INTERNAL_SECURITY_MODE/u);

    assert.equal(start.options.env, undefined);
    assert.deepEqual(start.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.match(start.args.at(-1) ?? "", /env_file=.*portable-devshell-env-/u);
    assert.match(start.args.at(-1) ?? "", /exec .*devshell-worker/u);
    assert.doesNotMatch(JSON.stringify(start.args), /remote-secret|\/remote\/home|\/remote\/bin/u);
    assert.doesNotMatch(JSON.stringify(result.details), /remote-secret|\/remote\/home|\/remote\/bin/u);
});

test("ssh RPC exit cleans an uploaded environment file after an early local termination", async () => {
    const recorder = createSpawnRecorder((_call, child, callIndex) => {
        if (callIndex === 0) {
            child.stdin.once("finish", () => closeRecordedChild(child));
            return true;
        }
        if (callIndex === 1) {
            return true;
        }
        return false;
    });
    const transport = new WorkerTransportDriverSsh({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        command: "ssh-bin devbox",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const rpc = await transport.spawnWorkerRpc({
        env: { API_TOKEN: "remote-secret" },
        instanceName: "task-3-ssh"
    });
    assert.equal(recorder.calls.length, 2);
    assert.equal(rpc.kill("SIGTERM"), true);
    assert.deepEqual(await rpc.exit, { code: null, signal: "SIGTERM" });
    assert.equal(recorder.calls.length, 3);
    const cleanup = recorder.calls[2];
    assert.ok(cleanup);
    assert.equal(cleanup.command, "ssh-bin");
    assert.match(cleanup.args.at(-1) ?? "", /rm -f .*portable-devshell-env-/u);
    assert.doesNotMatch(JSON.stringify(cleanup.args), /remote-secret/u);
});

test("ssh transport rejects environment keys that cannot be represented safely", async () => {
    const recorder = createSpawnRecorder();
    const transport = new WorkerTransportDriverSsh({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        command: "ssh-bin devbox",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await assert.rejects(
        transport.runWorkerCommand("start", {
            env: { "INVALID-KEY": "value" },
            instanceName: "task-3-ssh",
        }),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "core.providerFailed");
            assert.match(String((error as Error).message), /INVALID-KEY/u);
            return true;
        }
    );
    assert.equal(recorder.calls.length, 0);
});

test("ssh transport runs installWorker probe via remote shell", async () => {
    const recorder = createSpawnRecorder();
    const transport = new WorkerTransportDriverSsh({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        command: "ssh-bin devbox",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();

    assert.deepEqual(recorder.calls[0], {
        command: "ssh-bin",
        args: [
            "-oBatchMode=yes",
            "-oNumberOfPasswordPrompts=0",
            "-oKbdInteractiveAuthentication=no",
            "-oPasswordAuthentication=no",
            "devbox",
            "--",
            "sh",
            "-lc",
            shellEscape("'/usr/local/bin/devshell-worker' '--version'")
        ],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
});


test("Windows skill archives assign portable Unix modes from entry type and shebang", async (t) => {
    const root = await createTestTempDirectory("windows-skill-mode");
    const skillsDirectory = join(root, "skill");
    await mkdir(join(skillsDirectory, "review", "scripts"), { recursive: true });
    await writeFile(join(skillsDirectory, "review", "SKILL.md"), "# Review\n");
    await writeFile(join(skillsDirectory, "review", "scripts", "run.sh"), "#!/bin/sh\nprintf review\n");
    await writeFile(join(skillsDirectory, "review", "scripts", "helper.py"), "print('review')\n");
    t.after(() => rm(root, { recursive: true, force: true }));

    const archive = await createWorkerSkillArchive(skillsDirectory, "win32");
    assert.notEqual(archive, undefined);
    const entries = await readTarEntries(archive!.bytes);

    assert.deepEqual(entries, {
        "review/": { content: "", mode: 0o755, type: "directory" },
        "review/SKILL.md": { content: "# Review\n", mode: 0o644, type: "file" },
        "review/scripts/": { content: "", mode: 0o755, type: "directory" },
        "review/scripts/helper.py": { content: "print('review')\n", mode: 0o644, type: "file" },
        "review/scripts/run.sh": { content: "#!/bin/sh\nprintf review\n", mode: 0o755, type: "file" }
    });
});

test("ssh transport mirrors control skills to the remote user skill directory", async (t) => {
    const root = await createTestTempDirectory("skills");
    const skillsDirectory = join(root, "skill");
    const reviewDirectory = join(skillsDirectory, "review");
    const scriptsDirectory = join(reviewDirectory, "scripts");
    const skillPath = join(reviewDirectory, "SKILL.md");
    await mkdir(scriptsDirectory, { recursive: true });
    await chmod(reviewDirectory, 0o755);
    await chmod(scriptsDirectory, 0o755);
    await writeFile(skillPath, "# Review\n");
    await chmod(skillPath, 0o644);
    const scriptPath = join(scriptsDirectory, "run.sh");
    await writeFile(scriptPath, "#!/bin/sh\nprintf review\n");
    await chmod(scriptPath, 0o755);
    t.after(() => rm(root, { recursive: true, force: true }));

    const recorder = createSpawnRecorder((_call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "/home/dev" });
            return true;
        }
        if (callIndex === 1 || callIndex === 3) {
            child.stdin.once("finish", () => closeRecordedChild(child));
            return true;
        }
        if (callIndex === 2 || callIndex === 4) {
            closeRecordedChild(child, { stdout: "devshell-worker 0.0.0\n" });
            return true;
        }
        return false;
    });
    const transport = new WorkerTransportDriverSsh({
        command: "ssh-bin devbox",
        skillsDirectory,
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();
    await transport.installWorker();

    assert.equal(recorder.calls.length, 5);
    assert.equal(recorder.calls[1]?.args[8]?.includes("/home/dev/.devshell/skill"), true);
    assert.equal(recorder.calls[1]?.args[8]?.includes("tar -xpf -"), true);
    assert.deepEqual(recorder.calls[1]?.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(recorder.calls[2]?.args[8], shellEscape("'/usr/local/bin/devshell-worker' '--version'"));
    assert.equal(recorder.calls[3]?.args[8]?.includes("tar -xpf -"), true);
    assert.equal(recorder.calls[4]?.args[8], shellEscape("'/usr/local/bin/devshell-worker' '--version'"));

    const firstEntries = await readTarEntries(Buffer.concat(recorder.children[1]?.stdinChunks ?? []));
    const secondEntries = await readTarEntries(Buffer.concat(recorder.children[3]?.stdinChunks ?? []));
    assert.deepEqual(secondEntries, firstEntries);
    assert.deepEqual(firstEntries, {
        "review/": { content: "", mode: 0o755, type: "directory" },
        "review/SKILL.md": { content: "# Review\n", mode: 0o644, type: "file" },
        "review/scripts/": { content: "", mode: 0o755, type: "directory" },
        "review/scripts/run.sh": { content: "#!/bin/sh\nprintf review\n", mode: 0o755, type: "file" }
    });
});

test("remote skill synchronization atomically replaces the real target directory", async (t) => {
    if (process.platform === "win32") {
        t.skip("requires sh and tar");
        return;
    }

    const root = await createTestTempDirectory("real-skill-sync");
    const source = join(root, "control", "skill");
    const remoteHome = join(root, "remote-home");
    await mkdir(join(source, "review", "scripts"), { recursive: true });
    await mkdir(join(remoteHome, ".devshell", "skill", "stale"), { recursive: true });
    await writeFile(join(source, "review", "SKILL.md"), "first\n");
    const sourceScript = join(source, "review", "scripts", "run.sh");
    await writeFile(sourceScript, "#!/bin/sh\nprintf first\n");
    await chmod(sourceScript, 0o755);
    await writeFile(join(remoteHome, ".devshell", "skill", "stale", "old.txt"), "stale\n");
    t.after(() => rm(root, { recursive: true, force: true }));

    const installer = new WorkerInstallerRemote({
        createContext(operation, command) {
            return { command: [...command], commandDisplay: command.join(" "), operation, provider: "ssh" };
        },
        createProviderError(context, cause) {
            return createError({
                code: errorCodes.coreWorkerProvisionFailed,
                details: { operation: context.operation, provider: context.provider },
                message: cause instanceof Error ? cause.message : String(cause),
                retryable: false
            });
        },
        probeTarget: async () => getWorkerTargetByKey("linux-x64"),
        skillsDirectory: source,
        spawnShell(commandLine, stdio) {
            return nodeSpawn("sh", ["-lc", commandLine], { env: { ...process.env, HOME: remoteHome }, stdio });
        }
    });

    await installer.syncSkills();
    assert.equal(await readFile(join(remoteHome, ".devshell", "skill", "review", "SKILL.md"), "utf8"), "first\n");
    assert.equal((await stat(join(remoteHome, ".devshell", "skill", "review", "scripts", "run.sh"))).mode & 0o777, 0o755);
    await assert.rejects(readFile(join(remoteHome, ".devshell", "skill", "stale", "old.txt")), hasFsCode("ENOENT"));

    await writeFile(join(remoteHome, ".devshell", "skill", "review", "SKILL.md"), "corrupt\n");
    await installer.syncSkills();
    assert.equal(await readFile(join(remoteHome, ".devshell", "skill", "review", "SKILL.md"), "utf8"), "first\n");

    await rm(join(remoteHome, ".devshell", "skill", "review"), { recursive: true, force: true });
    await installer.syncSkills();
    assert.equal(await readFile(join(remoteHome, ".devshell", "skill", "review", "SKILL.md"), "utf8"), "first\n");
    assert.equal((await stat(join(remoteHome, ".devshell", "skill", "review", "scripts", "run.sh"))).mode & 0o777, 0o755);

    await writeFile(join(source, "review", "SKILL.md"), "second\n");
    await unlink(sourceScript);
    await installer.syncSkills();

    assert.equal(await readFile(join(remoteHome, ".devshell", "skill", "review", "SKILL.md"), "utf8"), "second\n");
    await assert.rejects(readFile(join(remoteHome, ".devshell", "skill", "review", "scripts", "run.sh")), hasFsCode("ENOENT"));
});

test("ssh transport probes remote target before installing default worker", async (t) => {
    const worker = await createDummyWorkerBinary();
    t.after(worker.cleanup);
    const previousWorkerPath = process.env.PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH;
    process.env.PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH = worker.path;
    t.after(() => {
        restoreEnv("PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH", previousWorkerPath);
    });

    const recorder = createSpawnRecorder((call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "Darwin\narm64\n" });
            return true;
        }

        if (callIndex === 1) {
            closeRecordedChild(child, { stdout: "/home/dev" });
            return true;
        }

        if (callIndex === 2) {
            closeRecordedChild(child, { stdout: "missing" });
            return true;
        }

        if (callIndex === 3) {
            child.stdin.once("finish", () => {
                closeRecordedChild(child);
            });
            return true;
        }

        if (callIndex === 4) {
            closeRecordedChild(child, { stdout: "running\n" });
            return true;
        }

        return false;
    });
    const transport = new WorkerTransportDriverSsh({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        command: "ssh-bin devbox",
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();

    assert.deepEqual(recorder.calls[0], {
        command: "ssh-bin",
        args: [
            "-oBatchMode=yes",
            "-oNumberOfPasswordPrompts=0",
            "-oKbdInteractiveAuthentication=no",
            "-oPasswordAuthentication=no",
            "devbox",
            "--",
            "sh",
            "-lc",
            shellEscape("uname -s && uname -m")
        ],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(recorder.calls[1], {
        command: "ssh-bin",
        args: [
            "-oBatchMode=yes",
            "-oNumberOfPasswordPrompts=0",
            "-oKbdInteractiveAuthentication=no",
            "-oPasswordAuthentication=no",
            "devbox",
            "--",
            "sh",
            "-lc",
            shellEscape('printf %s "${HOME:?HOME is required to install the worker}"')
        ],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.equal(recorder.calls[2]?.command, "ssh-bin");
    assert.equal(recorder.calls[2]?.args[8]?.includes("/home/dev/.devshell/workers/darwin-arm64/"), true);
    assert.equal(recorder.calls[2]?.args[8]?.includes("missing"), true);
    assert.deepEqual(recorder.calls[2]?.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(recorder.calls[3]?.command, "ssh-bin");
    assert.equal(recorder.calls[3]?.args[8]?.includes("tmp_binary_path"), true);
    assert.deepEqual(recorder.calls[3]?.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.deepEqual(recorder.calls[4], {
        command: "ssh-bin",
        args: [
            "-oBatchMode=yes",
            "-oNumberOfPasswordPrompts=0",
            "-oKbdInteractiveAuthentication=no",
            "-oPasswordAuthentication=no",
            "devbox",
            "--",
            "sh",
            "-lc",
            shellEscape("'/home/dev/.devshell/bin/devshell-worker' '--version'")
        ],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(Buffer.concat(recorder.children[3]?.stdinChunks ?? []), worker.contents);
});

test("ssh transport reuses a matching remote worker without uploading the binary", async (t) => {
    const worker = await createDummyWorkerBinary();
    t.after(worker.cleanup);
    const previousWorkerPath = process.env.PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH;
    process.env.PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH = worker.path;
    t.after(() => {
        restoreEnv("PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH", previousWorkerPath);
    });

    const recorder = createSpawnRecorder((_call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "Darwin\narm64\n" });
            return true;
        }
        if (callIndex === 1) {
            closeRecordedChild(child, { stdout: "/home/dev" });
            return true;
        }
        if (callIndex === 2) {
            closeRecordedChild(child, { stdout: "ready" });
            return true;
        }

        closeRecordedChild(child, { stdout: "running\n" });
        return true;
    });
    const transport = new WorkerTransportDriverSsh({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        command: "ssh-bin devbox",
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();

    assert.equal(recorder.calls.length, 4);
    assert.deepEqual(recorder.calls[2]?.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(recorder.calls[2]?.args[8]?.includes("ready"), true);
    assert.equal(Buffer.concat(recorder.children[2]?.stdinChunks ?? []).length, 0);
    assert.equal(recorder.calls.some((call) => call.args.some((arg) => arg.includes("tmp_binary_path"))), false);
});

test("remote installer surfaces missing target-specific asset as structured error", async () => {
    const installer = new WorkerInstallerRemote({
        probeTarget: async () => getWorkerTargetByKey("darwin-arm64"),
        resolver: {
            async resolve() {
                throw createError({
                    code: errorCodes.coreWorkerAssetUnavailable,
                    details: {
                        searchedPaths: [],
                        targetKey: "darwin-arm64"
                    },
                    message: "Worker asset is unavailable for target darwin-arm64.",
                    retryable: false
                });
            }
        } as never,
        spawnShell() {
            throw new Error("spawnShell should not be called when resolution fails");
        },
        createContext(operation, command) {
            return {
                command: [...command],
                commandDisplay: command.join(" "),
                operation,
                provider: "ssh"
            };
        },
        createProviderError(_context, cause) {
            throw cause;
        }
    });

    await assert.rejects(installer.ensure("devshell-worker"), (error: unknown) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.equal((error as { code?: string }).code, "core.workerAssetUnavailable");
        assert.equal((error as { details?: Record<string, unknown> }).details?.targetKey, "darwin-arm64");
        return true;
    });
});

test("ssh transport reinstalls default worker when target asset changes", async (t) => {
    const firstWorker = await createDummyWorkerBinary("first");
    const secondWorker = await createDummyWorkerBinary("second");
    t.after(firstWorker.cleanup);
    t.after(secondWorker.cleanup);

    const previousWorkerPath = process.env.PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH;
    process.env.PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH = firstWorker.path;
    t.after(() => {
        restoreEnv("PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH", previousWorkerPath);
    });

    const recorder = createSpawnRecorder((_call, child, callIndex) => {
        if (callIndex === 0 || callIndex === 5) {
            closeRecordedChild(child, { stdout: "Darwin\narm64\n" });
            return true;
        }

        if (callIndex === 1) {
            closeRecordedChild(child, { stdout: "/home/dev" });
            return true;
        }

        if (callIndex === 2 || callIndex === 6) {
            closeRecordedChild(child, { stdout: "missing" });
            return true;
        }

        if (callIndex === 3 || callIndex === 7) {
            child.stdin.once("finish", () => {
                closeRecordedChild(child);
            });
            return true;
        }

        closeRecordedChild(child);
        return true;
    });
    const transport = new WorkerTransportDriverSsh({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        command: "ssh-bin devbox",
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();
    process.env.PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH = secondWorker.path;
    await transport.installWorker();

    assert.equal(Buffer.concat(recorder.children[3]?.stdinChunks ?? []).equals(firstWorker.contents), true);
    assert.equal(Buffer.concat(recorder.children[7]?.stdinChunks ?? []).equals(secondWorker.contents), true);
    assert.notEqual(recorder.calls[3]?.args[8], recorder.calls[7]?.args[8]);
});

test("ssh transport appends interactive-auth hint when batch mode authentication fails", async () => {
    const recorder = createSpawnRecorder((_call, child) => {
        closeRecordedChild(child, {
            code: 255,
            stderr: "Permission denied (publickey,password).\n"
        });
        return true;
    });
    const transport = new WorkerTransportDriverSsh({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        command: "ssh demo",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("status", { instanceName: "demo-ssh" });

    assert.equal(result.exitCode, 255);
    assert.match(result.stderr, /requires interactive authentication or host confirmation/u);
    assert.equal(result.details?.stderrTail?.includes("requires interactive authentication or host confirmation"), true);
});

test("ssh transport interactive start establishes a reusable control socket", async () => {
    const outputs: string[] = [];
    const recorder = createSpawnRecorder((_call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "Password: " });
            return true;
        }

        closeRecordedChild(child);
        return true;
    });
    const transport = new WorkerTransportDriverSsh({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        command: "ssh-bin devbox",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const startResult = await transport.runWorkerCommand(
        "start",
        { instanceName: "demo-ssh" },
        {
            async readInput() {
                return undefined;
            },
            async writeOutput(chunk: string) {
                outputs.push(chunk);
            }
        }
    );
    const rpcProcess = await transport.spawnWorkerRpc({ instanceName: "demo-ssh" });
    rpcProcess.kill("SIGTERM");
    await rpcProcess.exit;

    assert.equal(startResult.exitCode, 0);
    assert.equal(outputs.join(""), "Password: ");
    assert.equal(recorder.calls[0]?.command, "script");
    assert.equal(recorder.calls[0]?.args[0], "-qefc");
    assert.match(String(recorder.calls[0]?.args[1] ?? ""), /-oControlMaster=auto/u);
    assert.match(String(recorder.calls[0]?.args[1] ?? ""), /-oControlPersist=600/u);

    const controlPath = String(recorder.calls[1]?.args.find((arg) => arg.startsWith("-oControlPath=")) ?? "").slice("-oControlPath=".length);
    assert.match(controlPath, /pds-ssh-/u);
    assert.deepEqual(recorder.calls[1], {
        command: "ssh-bin",
        args: [
            "-oBatchMode=yes",
            "-oNumberOfPasswordPrompts=0",
            "-oKbdInteractiveAuthentication=no",
            "-oPasswordAuthentication=no",
            `-oControlPath=${controlPath}`,
            "-oControlMaster=auto",
            "-oControlPersist=600",
            "devbox",
            "--",
            "sh",
            "-lc",
            shellEscape("'/usr/local/bin/devshell-worker' 'start' '--instance' 'demo-ssh'")
        ],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(recorder.calls[2], {
        command: "ssh-bin",
        args: [
            "-oBatchMode=yes",
            "-oNumberOfPasswordPrompts=0",
            "-oKbdInteractiveAuthentication=no",
            "-oPasswordAuthentication=no",
            `-oControlPath=${controlPath}`,
            "-oControlMaster=auto",
            "-oControlPersist=600",
            "devbox",
            "--",
            "sh",
            "-lc",
            shellEscape("'/usr/local/bin/devshell-worker' 'rpc' '--instance' 'demo-ssh'")
        ],
        options: { cwd: undefined, env: undefined, stdio: ["pipe", "pipe", "pipe"] }
    });
});

test("docker transport builds exec command", async () => {
    const recorder = createSpawnRecorder((call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "running\n" });
            return true;
        }

        return false;
    });
    const transport = new WorkerTransportDriverDocker({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: createManagedContainerConfig(),
        dockerBinary: "docker-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("logs", { instanceName: "task-3-docker" });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(recorder.calls[0], {
        command: "docker-bin",
        args: ["inspect", "--type", "container", "--format", "{{.State.Status}}", "worker-container"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(recorder.calls[1], {
        command: "docker-bin",
        args: ["exec", "-i", "worker-container", "/usr/local/bin/devshell-worker", "logs", "--instance", "task-3-docker"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
});

test("docker transport runs installWorker probe via exec", async () => {
    const recorder = createSpawnRecorder((call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "running\n" });
            return true;
        }

        return false;
    });
    const transport = new WorkerTransportDriverDocker({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: createManagedContainerConfig(),
        dockerBinary: "docker-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();

    assert.deepEqual(recorder.calls[0], {
        command: "docker-bin",
        args: ["inspect", "--type", "container", "--format", "{{.State.Status}}", "worker-container"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(recorder.calls[1], {
        command: "docker-bin",
        args: ["exec", "-i", "worker-container", "/usr/local/bin/devshell-worker", "--version"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
});

test("docker transport mirrors control skills into the container user home", async (t) => {
    const root = await createTestTempDirectory("container-skills");
    const skillsDirectory = join(root, "skill");
    await mkdir(join(skillsDirectory, "build"), { recursive: true });
    await writeFile(join(skillsDirectory, "build", "SKILL.md"), "# Build\n");
    t.after(() => rm(root, { recursive: true, force: true }));

    const recorder = createSpawnRecorder((_call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "running\n" });
            return true;
        }
        if (callIndex === 1) {
            closeRecordedChild(child, { stdout: "/home/dev" });
            return true;
        }
        if (callIndex === 2) {
            child.stdin.once("finish", () => closeRecordedChild(child));
            return true;
        }
        return false;
    });
    const transport = new WorkerTransportDriverDocker({
        container: createManagedContainerConfig(),
        dockerBinary: "docker-bin",
        skillsDirectory,
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();

    assert.equal(recorder.calls.length, 4);
    assert.deepEqual(recorder.calls[1]?.args.slice(0, 5), ["exec", "-i", "worker-container", "sh", "-lc"]);
    assert.equal(recorder.calls[2]?.args[5]?.includes("/home/dev/.devshell/skill"), true);
    assert.equal(recorder.calls[2]?.args[5]?.includes("tar -xpf -"), true);
    assert.ok(Buffer.concat(recorder.children[2]?.stdinChunks ?? []).length > 0);
    assert.deepEqual(recorder.calls[3]?.args, [
        "exec", "-i", "worker-container", "/usr/local/bin/devshell-worker", "--version"
    ]);
});

test("docker transport installs default worker before exec command", async (t) => {
    const worker = await createDummyWorkerBinary();
    t.after(worker.cleanup);
    const previousWorkerPath = process.env.PORTABLE_DEVSHELL_WORKER_LINUX_ARM64_PATH;
    process.env.PORTABLE_DEVSHELL_WORKER_LINUX_ARM64_PATH = worker.path;
    t.after(() => {
        restoreEnv("PORTABLE_DEVSHELL_WORKER_LINUX_ARM64_PATH", previousWorkerPath);
    });

    const recorder = createSpawnRecorder((_call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "running\n" });
            return true;
        }

        if (callIndex === 1) {
            closeRecordedChild(child, { stdout: "Linux\naarch64\n" });
            return true;
        }

        if (callIndex === 2) {
            closeRecordedChild(child, { stdout: "/home/dev" });
            return true;
        }

        if (callIndex === 3) {
            closeRecordedChild(child, { stdout: "missing" });
            return true;
        }

        if (callIndex === 4) {
            child.stdin.once("finish", () => {
                closeRecordedChild(child);
            });
            return true;
        }

        return false;
    });
    const transport = new WorkerTransportDriverDocker({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: createManagedContainerConfig(),
        dockerBinary: "docker-bin",
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("logs", { instanceName: "task-3-docker" });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(recorder.calls[0], {
        command: "docker-bin",
        args: ["inspect", "--type", "container", "--format", "{{.State.Status}}", "worker-container"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(recorder.calls[1], {
        command: "docker-bin",
        args: ["exec", "-i", "worker-container", "sh", "-lc", "uname -s && uname -m"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(recorder.calls[2], {
        command: "docker-bin",
        args: ["exec", "-i", "worker-container", "sh", "-lc", 'printf %s "${HOME:?HOME is required to install the worker}"'],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.equal(recorder.calls[3]?.args[5]?.includes("/home/dev/.devshell/workers/linux-arm64/"), true);
    assert.deepEqual(recorder.calls[3]?.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(recorder.calls[4]?.args[5]?.includes('cat > "$tmp_binary_path"'), true);
    assert.deepEqual(recorder.calls[4]?.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.deepEqual(recorder.calls[5], {
        command: "docker-bin",
        args: [
            "exec",
            "-i",
            "worker-container",
            "/home/dev/.devshell/bin/devshell-worker",
            "logs",
            "--instance",
            "task-3-docker"
        ],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(Buffer.concat(recorder.children[4]?.stdinChunks ?? []), worker.contents);
});

test("podman transport builds exec command", async () => {
    const recorder = createSpawnRecorder((call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "running\n" });
            return true;
        }

        return false;
    });
    const transport = new WorkerTransportDriverPodman({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: createManagedContainerConfig(),
        podmanBinary: "podman-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("stop", { instanceName: "task-3-podman" });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(recorder.calls[0], {
        command: "podman-bin",
        args: ["inspect", "--type", "container", "--format", "{{.State.Status}}", "worker-container"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(recorder.calls[1], {
        command: "podman-bin",
        args: ["exec", "-i", "worker-container", "/usr/local/bin/devshell-worker", "stop", "--instance", "task-3-podman"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(recorder.calls[2], {
        command: "podman-bin",
        args: ["stop", "worker-container"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
});

test("podman transport preserves provider storage environment and forwards worker environment", async () => {
    const recorder = createSpawnRecorder((call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "running\n" });
            return true;
        }
        return false;
    });
    const transport = new WorkerTransportDriverPodman({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: createManagedContainerConfig(),
        podmanBinary: "podman-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const previousRuntime = process.env.XDG_RUNTIME_DIR;
    process.env.HOME = "/control/home";
    process.env.PATH = "/provider/bin";
    process.env.XDG_RUNTIME_DIR = "/control/runtime";

    try {
        await transport.runWorkerCommand("stop", {
            env: {
                DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: "workspace",
                DEVSHELL_WORKER_SECURITY_MODE: "workspace",
                FOO: "bar"
            },
            instanceName: "task-3-podman"
        });
    } finally {
        restoreEnv("HOME", previousHome);
        restoreEnv("PATH", previousPath);
        restoreEnv("XDG_RUNTIME_DIR", previousRuntime);
    }

    const exec = recorder.calls[1];
    assert.ok(exec);
    assert.deepEqual(exec.args.slice(0, 7), [
        "exec",
        "-i",
        "-e",
        "DEVSHELL_WORKER_SECURITY_MODE",
        "-e",
        "FOO",
        "worker-container"
    ]);
    assert.equal(exec.args.includes("DEVSHELL_WORKER_INTERNAL_SECURITY_MODE"), false);
    assert.equal(exec.options.env?.HOME, "/control/home");
    assert.equal(exec.options.env?.PATH, "/provider/bin");
    assert.equal(exec.options.env?.XDG_RUNTIME_DIR, "/control/runtime");
    assert.equal(exec.options.env?.FOO, "bar");
    assert.equal(exec.options.env?.DEVSHELL_WORKER_SECURITY_MODE, "workspace");
});

test("Windows container provider environment canonicalizes reserved keys case-insensitively", () => {
    const environment = createContainerWorkerEnvironment({
        env: { FOO: "bar" },
        platform: "win32",
        processEnvironment: {
            HOME: "C:\\Users\\runner",
            Path: "C:\\provider\\bin",
            Xdg_Runtime_Dir: "C:\\runtime"
        },
        provider: "podman"
    });

    assert.equal(environment.processEnv?.PATH, "C:\\provider\\bin");
    assert.equal(environment.processEnv?.XDG_RUNTIME_DIR, "C:\\runtime");
    assert.equal(environment.processEnv?.Path, undefined);
    assert.equal(environment.processEnv?.Xdg_Runtime_Dir, undefined);
    assert.equal(environment.processEnv?.FOO, "bar");
    assert.throws(
        () => createContainerWorkerEnvironment({
            env: { path: "C:\\override" },
            platform: "win32",
            processEnvironment: {},
            provider: "podman"
        }),
        /cannot override provider-reserved variables: PATH/u
    );
});

test("podman transport rejects provider-reserved instance environment before provisioning", async () => {
    const recorder = createSpawnRecorder();
    const transport = new WorkerTransportDriverPodman({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: createManagedContainerConfig(),
        podmanBinary: "podman-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await assert.rejects(
        transport.runWorkerCommand("start", {
            env: { HOME: "/worker/home", PATH: "/worker/bin" },
            instanceName: "task-3-podman",
        }),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "core.providerFailed");
            assert.match(String((error as Error).message), /HOME, PATH/u);
            return true;
        }
    );
    assert.equal(recorder.calls.length, 0);
});


test("podman transport runs installWorker probe via exec", async () => {
    const recorder = createSpawnRecorder((call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "running\n" });
            return true;
        }

        return false;
    });
    const transport = new WorkerTransportDriverPodman({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: createManagedContainerConfig(),
        podmanBinary: "podman-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();

    assert.deepEqual(recorder.calls[0], {
        command: "podman-bin",
        args: ["inspect", "--type", "container", "--format", "{{.State.Status}}", "worker-container"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(recorder.calls[1], {
        command: "podman-bin",
        args: ["exec", "-i", "worker-container", "/usr/local/bin/devshell-worker", "--version"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
});

test("podman transport installs default worker before spawning rpc", async (t) => {
    const worker = await createDummyWorkerBinary();
    t.after(worker.cleanup);
    const previousWorkerPath = process.env.PORTABLE_DEVSHELL_WORKER_LINUX_ARM64_PATH;
    process.env.PORTABLE_DEVSHELL_WORKER_LINUX_ARM64_PATH = worker.path;
    t.after(() => {
        restoreEnv("PORTABLE_DEVSHELL_WORKER_LINUX_ARM64_PATH", previousWorkerPath);
    });

    const recorder = createSpawnRecorder((_call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "running\n" });
            return true;
        }

        if (callIndex === 1) {
            closeRecordedChild(child, { stdout: "Linux\naarch64\n" });
            return true;
        }

        if (callIndex === 2) {
            closeRecordedChild(child, { stdout: "/home/dev" });
            return true;
        }

        if (callIndex === 3) {
            closeRecordedChild(child, { stdout: "missing" });
            return true;
        }

        if (callIndex === 4) {
            child.stdin.once("finish", () => {
                closeRecordedChild(child);
            });
            return true;
        }

        return false;
    });
    const transport = new WorkerTransportDriverPodman({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: createManagedContainerConfig(),
        podmanBinary: "podman-bin",
        spawnFunction: recorder.spawn
    });

    const rpcProcess = await transport.spawnWorkerRpc({ instanceName: "task-3-podman" });
    t.after(() => {
        rpcProcess.kill("SIGTERM");
    });

    assert.equal(rpcProcess.stdin, recorder.children[5]?.stdin);
    assert.equal(rpcProcess.stdout, recorder.children[5]?.stdout);
    assert.equal(rpcProcess.stderr, recorder.children[5]?.stderr);
    assert.deepEqual(recorder.calls[0], {
        command: "podman-bin",
        args: ["inspect", "--type", "container", "--format", "{{.State.Status}}", "worker-container"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(recorder.calls[1], {
        command: "podman-bin",
        args: ["exec", "-i", "worker-container", "sh", "-lc", "uname -s && uname -m"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(recorder.calls[2], {
        command: "podman-bin",
        args: ["exec", "-i", "worker-container", "sh", "-lc", 'printf %s "${HOME:?HOME is required to install the worker}"'],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.equal(recorder.calls[3]?.args[5]?.includes("/home/dev/.devshell/workers/linux-arm64/"), true);
    assert.deepEqual(recorder.calls[3]?.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(recorder.calls[4]?.args[5]?.includes('cat > "$tmp_binary_path"'), true);
    assert.deepEqual(recorder.calls[4]?.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.deepEqual(recorder.calls[5], {
        command: "podman-bin",
        args: [
            "exec",
            "-i",
            "worker-container",
            "/home/dev/.devshell/bin/devshell-worker",
            "rpc",
            "--instance",
            "task-3-podman"
        ],
        options: { cwd: undefined, env: undefined, stdio: ["pipe", "pipe", "pipe"] }
    });
    assert.deepEqual(Buffer.concat(recorder.children[4]?.stdinChunks ?? []), worker.contents);
    assert.equal(rpcProcess.kill("SIGTERM"), true);
    assert.deepEqual(await rpcProcess.exit, { code: null, signal: "SIGTERM" });
});

test("docker transport creates and starts managed containers before starting the worker", async () => {
    const recorder = createSpawnRecorder((call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stderr: "No such container\n", code: 1 });
            return true;
        }

        return false;
    });
    const transport = new WorkerTransportDriverDocker({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: {
            containerName: "worker-container",
            image: "archlinux:latest",
            mode: "preset",
            preset: "arch"
        },
        dockerBinary: "docker-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("start", {
        instanceName: "task-3-docker",
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(recorder.calls[0]?.args, ["inspect", "--type", "container", "--format", "{{.State.Status}}", "worker-container"]);
    assert.deepEqual(recorder.calls[1]?.args.slice(0, 3), ["create", "--name", "worker-container"]);
    assert.equal(recorder.calls[1]?.args.includes("/workspace:/workspace:rw"), false);
    assert.equal(recorder.calls[1]?.args.includes("archlinux:latest"), true);
    assert.deepEqual(recorder.calls[2]?.args, ["start", "worker-container"]);
    assert.deepEqual(recorder.calls[3]?.args, [
        "exec",
        "-i",
        "worker-container",
        "/usr/local/bin/devshell-worker",
        "start",
        "--instance",
        "task-3-docker"
    ]);
});

test("dockerfile container mode builds the image before creating the managed container", async () => {
    const recorder = createSpawnRecorder((call, child) => {
        if (call.args[0] === "image" && call.args[1] === "inspect") {
            closeRecordedChild(child, { stderr: "image missing\n", code: 1 });
            return true;
        }

        if (call.args[0] === "inspect" && call.args[1] === "--type") {
            closeRecordedChild(child, { stderr: "No such container\n", code: 1 });
            return true;
        }

        return false;
    });
    const transport = new WorkerTransportDriverDocker({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: {
            build: {
                context: "/project",
                dockerfile: "/project/Containerfile",
                tag: "devshell-test:latest"
            },
            containerName: "dockerfile-container",
            mode: "dockerfile"
        },
        dockerBinary: "docker-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.runWorkerCommand("start", {
        instanceName: "task-3-dockerfile",
    });

    assert.deepEqual(recorder.calls.map((call) => call.args), [
        ["image", "inspect", "devshell-test:latest"],
        ["build", "-t", "devshell-test:latest", "-f", "/project/Containerfile", "/project"],
        ["inspect", "--type", "container", "--format", "{{.State.Status}}", "dockerfile-container"],
        ["create", "--name", "dockerfile-container", "devshell-test:latest", "sh", "-lc", "trap 'exit 0' TERM INT; while :; do sleep 2147483647; done"],
        ["start", "dockerfile-container"],
        [
            "exec",
            "-i",
            "dockerfile-container",
            "/usr/local/bin/devshell-worker",
            "start",
            "--instance",
            "task-3-dockerfile"
        ]
    ]);
});

test("compose container mode starts the configured service and executes the worker through compose", async () => {
    const recorder = createSpawnRecorder();
    const transport = new WorkerTransportDriverDocker({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: {
            compose: {
                file: "/project/compose.yaml",
                projectName: "devshell-test",
                service: "workspace"
            },
            mode: "compose"
        },
        dockerBinary: "docker-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.runWorkerCommand("start", {
        instanceName: "task-3-compose",
    });

    assert.deepEqual(recorder.calls.map((call) => call.args), [
        ["compose", "-f", "/project/compose.yaml", "-p", "devshell-test", "ps", "-q", "workspace"],
        ["compose", "-f", "/project/compose.yaml", "-p", "devshell-test", "up", "-d", "workspace"],
        [
            "compose",
            "-f",
            "/project/compose.yaml",
            "-p",
            "devshell-test",
            "exec",
            "-T",
            "workspace",
            "/usr/local/bin/devshell-worker",
            "start",
            "--instance",
            "task-3-compose"
        ]
    ]);
});

test("existing image container mode creates a dedicated managed container", async () => {
    const recorder = createSpawnRecorder((call, child) => {
        if (call.args[0] === "inspect") {
            closeRecordedChild(child, { stderr: "No such container\n", code: 1 });
            return true;
        }

        return false;
    });
    const transport = new WorkerTransportDriverPodman({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: {
            containerName: "existing-image-container",
            image: "registry.example/devshell:latest",
            mode: "existingImage"
        },
        podmanBinary: "podman-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.runWorkerCommand("start", {
        instanceName: "task-3-existing-image",
    });

    assert.deepEqual(recorder.calls[1]?.args.slice(0, 4), [
        "create",
        "--name",
        "existing-image-container",
        "--userns=keep-id"
    ]);
    assert.equal(recorder.calls[1]?.args.includes("registry.example/devshell:latest"), true);
    assert.equal(
        recorder.calls[1]?.args.includes("/workspace:/workspace:rw"),
        false
    );
    assert.deepEqual(recorder.calls[2]?.args, ["start", "existing-image-container"]);
    assert.deepEqual(recorder.calls[3]?.args.slice(0, 3), ["exec", "-i", "existing-image-container"]);
});

test("managed container uses an explicit workspace mount without adding a duplicate", async () => {
    const recorder = createSpawnRecorder((call, child) => {
        if (call.args[0] === "inspect") {
            closeRecordedChild(child, { stderr: "No such container\n", code: 1 });
            return true;
        }
        return false;
    });
    const transport = new WorkerTransportDriverPodman({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: {
            containerName: "mounted-container",
            image: "registry.example/devshell:latest",
            mode: "existingImage",
            mounts: [{ mode: "ro", source: "/host/project", target: "/workspace" }]
        },
        podmanBinary: "podman-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.runWorkerCommand("start", {
        instanceName: "task-3-mounted-image",
    });

    assert.equal(
        recorder.calls[1]?.args.filter((arg) => arg.endsWith(":/workspace:rw")).length,
        0
    );
    assert.equal(
        recorder.calls[1]?.args.filter((arg) => arg === "/host/project:/workspace:ro").length,
        1
    );
});

test("existing stopped container mode adopts and restores the configured lifecycle", async () => {
    let inspectCount = 0;
    const recorder = createSpawnRecorder((call, child) => {
        if (call.args[0] === "inspect") {
            closeRecordedChild(child, { stdout: inspectCount++ === 0 ? "stopped\n" : "running\n" });
            return true;
        }

        return false;
    });
    const transport = new WorkerTransportDriverPodman({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: {
            adoptLifecycle: true,
            containerName: "adopted-container",
            mode: "existingStoppedContainer"
        },
        podmanBinary: "podman-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.runWorkerCommand("start", {
        instanceName: "task-3-adopted",
    });
    await transport.runWorkerCommand("stop", { instanceName: "task-3-adopted" });

    assert.deepEqual(recorder.calls.map((call) => call.args), [
        ["inspect", "--type", "container", "--format", "{{.State.Status}}", "adopted-container"],
        ["start", "adopted-container"],
        [
            "exec",
            "-i",
            "adopted-container",
            "/usr/local/bin/devshell-worker",
            "start",
            "--instance",
            "task-3-adopted"
        ],
        ["inspect", "--type", "container", "--format", "{{.State.Status}}", "adopted-container"],
        ["exec", "-i", "adopted-container", "/usr/local/bin/devshell-worker", "stop", "--instance", "task-3-adopted"],
        ["stop", "adopted-container"]
    ]);
});

test("podman transport rejects already running existing stopped containers", async () => {
    const recorder = createSpawnRecorder((call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "running\n" });
            return true;
        }

        return false;
    });
    const transport = new WorkerTransportDriverPodman({
        skillsDirectory: NO_SKILLS_DIRECTORY,
        container: {
            adoptLifecycle: true,
            containerName: "worker-container",
            mode: "existingStoppedContainer"
        },
        podmanBinary: "podman-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await assert.rejects(
        transport.runWorkerCommand("start", { instanceName: "task-3-podman" }),
        /Running container attach is not a supported instance mode/u
    );
});

test("local transport executes frozen devshell-worker start status logs stop rpc", realWorkerTestOptions(workerBinaryPath), async (t) => {
    const homeDirectory = await createTestTempDirectory("core-home");
    const runtimeDirectory = await createTestTempDirectory("core-runtime");
    const instanceName = `task-3-${process.pid}`;
    const env = { ...process.env, HOME: homeDirectory, XDG_RUNTIME_DIR: runtimeDirectory };
    const transport = new WorkerTransportDriverLocal({
        workerBinary: new WorkerBinary(workerBinaryPath!),
        spawnFunction: nodeSpawn
    });

    t.after(async () => {
        await transport.runWorkerCommand("stop", { env, instanceName });
        await rm(homeDirectory, { recursive: true, force: true });
        await rm(runtimeDirectory, { recursive: true, force: true });
    });

    await transport.installWorker();

    const startResult = await transport.runWorkerCommand("start", { env, instanceName });
    assert.equal(startResult.exitCode, 0);
    assert.equal("workspace" in JSON.parse(startResult.stdout), false);

    const statusResult = await transport.runWorkerCommand("status", { env, instanceName });
    assert.equal(statusResult.exitCode, 0);
    assert.equal(JSON.parse(statusResult.stdout).running, true);

    const logsResult = await transport.runWorkerCommand("logs", { env, instanceName });
    assert.equal(logsResult.exitCode, 0);

    const rpcProcess = await transport.spawnWorkerRpc({ env, instanceName });
    assert.notEqual(rpcProcess.stdin, null);
    assert.notEqual(rpcProcess.stdout, null);
    assert.notEqual(rpcProcess.stderr, null);
    assert.equal(rpcProcess.kill("SIGTERM"), true);
    const rpcExit = await rpcProcess.exit;
    if (process.platform === "win32") {
        assert.notDeepEqual(rpcExit, { code: 0, signal: null });
    } else {
        assert.deepEqual(rpcExit, { code: null, signal: "SIGTERM" });
    }

    const stopResult = await transport.runWorkerCommand("stop", { env, instanceName });
    assert.equal(stopResult.exitCode, 0);
    assert.equal(JSON.parse(stopResult.stdout).stopped, true);
});

interface RecordedCall {
    command: string;
    args: string[];
    options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: readonly string[] };
}

type SpawnFunctionLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

interface RecordedChild extends ChildProcess {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    stdinChunks: Buffer[];
}

function restoreEnv(name: keyof NodeJS.ProcessEnv, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
}

function createManagedContainerConfig() {
    return {
        containerName: "worker-container",
        image: "worker-image:latest",
        mode: "existingImage" as const
    };
}

function createSpawnRecorder(
    onSpawn?: (call: RecordedCall, child: RecordedChild, callIndex: number) => boolean
): {
    calls: RecordedCall[];
    children: RecordedChild[];
    spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
} {
    const calls: RecordedCall[] = [];
    const children: RecordedChild[] = [];

    return {
        calls,
        children,
        spawn(command, args, options) {
            const stdin = new PassThrough();
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            const stdinChunks: Buffer[] = [];
            const originalEnd = stdin.end.bind(stdin);
            const child = new EventEmitter() as RecordedChild;

            child.stdin = stdin;
            child.stdout = stdout;
            child.stderr = stderr;
            child.stdinChunks = stdinChunks;
            stdin.end = ((...args: Parameters<PassThrough["end"]>) => {
                const result = originalEnd(...args);
                setImmediate(() => {
                    stdin.emit("finish");
                });
                return result;
            }) as PassThrough["end"];
            child.kill = (signal?: NodeJS.Signals | number) => {
                setImmediate(() => {
                    stdin.end();
                    stdout.end();
                    stderr.end();
                    child.emit("exit", null, typeof signal === "string" ? signal : "SIGTERM");
                    child.emit("close", null, typeof signal === "string" ? signal : "SIGTERM");
                });
                return true;
            };

            calls.push({
                command,
                args: [...args],
                options: {
                    cwd: options.cwd?.toString(),
                    env: options.env,
                    stdio: Array.isArray(options.stdio) ? options.stdio.map((item) => String(item)) : []
                }
            });
            stdin.on("data", (chunk) => {
                stdinChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            children.push(child);

            const handled = onSpawn?.(calls[calls.length - 1]!, child, calls.length - 1) ?? false;

            if (!handled && options.stdio?.[0] === "ignore") {
                setImmediate(() => {
                    stdin.end();
                    stdout.end();
                    stderr.end();
                    child.emit("exit", 0, null);
                    child.emit("close", 0, null);
                });
            }

            return child;
        }
    };
}

async function createDummyWorkerBinary(tag: string = "remote"): Promise<{
    path: string;
    contents: Buffer;
    cleanup: () => Promise<void>;
}> {
    const directory = await createTestTempDirectory("core-worker");
    const path = join(directory, "devshell-worker");
    const contents = Buffer.from(`#!/bin/sh\necho remote worker ${tag}\n`, "utf8");

    await writeFile(path, contents, { mode: 0o755 });

    return {
        path,
        contents,
        cleanup: async () => {
            await rm(directory, { recursive: true, force: true });
        }
    };
}

async function installedWorkerSha(path: string): Promise<string> {
    if (process.platform === "win32") {
        return createHash("sha256").update(await readFile(path)).digest("hex");
    }
    const target = await readlink(path);
    const match = target.match(/[a-f0-9]{64}/u);
    assert.notEqual(match, null, `installed worker symlink does not contain a sha256: ${target}`);
    return match![0];
}

async function readTarEntries(bytes: Buffer): Promise<Record<string, { content: string; mode: number; type: string }>> {
    const parser = extract();
    const entries: Record<string, { content: string; mode: number; type: string }> = {};

    await new Promise<void>((resolve, reject) => {
        parser.on("entry", (header, stream, next) => {
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
            stream.once("error", reject);
            stream.once("end", () => {
                entries[header.name] = {
                    content: Buffer.concat(chunks).toString("utf8"),
                    mode: header.mode ?? 0,
                    type: header.type ?? "file"
                };
                next();
            });
            stream.resume();
        });
        parser.once("error", reject);
        parser.once("finish", resolve);
        parser.end(bytes);
    });

    return entries;
}

function hasFsCode(expected: string): (error: unknown) => boolean {
    return (error: unknown) => {
        assert.equal((error as { code?: string }).code, expected);
        return true;
    };
}

function closeRecordedChild(
    child: RecordedChild,
    options: {
        stdout?: string;
        stderr?: string;
        code?: number;
        signal?: NodeJS.Signals | null;
    } = {}
): void {
    const code = options.code ?? 0;
    const signal = options.signal ?? null;

    setImmediate(() => {
        if (options.stdout !== undefined) {
            child.stdout.write(options.stdout);
        }
        if (options.stderr !== undefined) {
            child.stderr.write(options.stderr);
        }
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", code, signal);
        child.emit("close", code, signal);
    });
}
