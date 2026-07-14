import assert from "node:assert/strict";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    DockerWorkerTransport,
    LocalWorkerTransport,
    PodmanWorkerTransport,
    RemoteWorkerInstaller,
    SshWorkerTransport,
    WorkerBinary,
    getWorkerTargetByKey,
    probeLocalWorkerTarget
} from "@portable-devshell/core";
import { createError, errorCodes } from "@portable-devshell/shared";

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
    const transport = new LocalWorkerTransport({
        workerBinary: new WorkerBinary("/worker/bin"),
        spawnFunction: recorder.spawn
    });

    const startResult = await transport.runWorkerCommand("start", {
        instanceName: "task-3-local",
        workspacePath: "/tmp/workspace"
    });

    assert.equal(startResult.exitCode, 0);
    assert.equal(recorder.calls[0]?.command, "/worker/bin");
    assert.deepEqual(recorder.calls[0]?.args, ["start", "--instance", "task-3-local"]);
    assert.equal(recorder.calls[0]?.options.cwd, "/tmp/workspace");
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
    const transport = new LocalWorkerTransport({
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
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-custom-home-"));
    const devshellHome = join(root, "custom-devshell-home");
    const worker = await createDummyWorkerBinary("custom-home");
    t.after(async () => {
        await worker.cleanup();
        await rm(root, { recursive: true, force: true });
    });

    const target = probeLocalWorkerTarget();
    const workerPathEnvironmentName = `PORTABLE_DEVSHELL_WORKER_${target.key.replaceAll("-", "_").toUpperCase()}_PATH`;
    const recorder = createSpawnRecorder();
    const transport = new LocalWorkerTransport({ spawnFunction: recorder.spawn });
    const result = await transport.runWorkerCommand("status", {
        env: {
            PORTABLE_DEVSHELL_HOME: devshellHome,
            [workerPathEnvironmentName]: worker.path
        },
        instanceName: "custom-home-local"
    });

    assert.equal(result.exitCode, 0);
    assert.equal(recorder.calls[0]?.command, join(devshellHome, "bin", "devshell-worker"));
    assert.equal(await readlink(join(devshellHome, "bin", "devshell-worker")), `devshell-worker-${target.key}`);
    assert.match(
        await readlink(join(devshellHome, "bin", `devshell-worker-${target.key}`)),
        new RegExp(`^\\.\\./workers/${target.key}/[a-f0-9]{64}/devshell-worker(?:\\.exe)?$`, "u")
    );
});

test("provider installWorker failures keep diagnostic details across local ssh docker and podman", async () => {
    const cases = [
        {
            build: (spawnFunction: SpawnFunctionLike) =>
                new LocalWorkerTransport({
                    workerBinary: new WorkerBinary("/worker/bin"),
                    spawnFunction
                }),
            expectedCommandPart: "/worker/bin",
            provider: "local"
        },
        {
            build: (spawnFunction: SpawnFunctionLike) =>
                new SshWorkerTransport({
                    command: "ssh-bin devbox",
                    workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
                    spawnFunction
                }),
            expectedCommandPart: "ssh-bin",
            provider: "ssh"
        },
        {
            build: (spawnFunction: SpawnFunctionLike) =>
                new DockerWorkerTransport({
                    container: createManagedContainerConfig(),
                    dockerBinary: "docker-bin",
                    workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
                    spawnFunction
                }),
            expectedCommandPart: "/usr/local/bin/devshell-worker",
            provider: "docker"
        },
        {
            build: (spawnFunction: SpawnFunctionLike) =>
                new PodmanWorkerTransport({
                    container: createManagedContainerConfig(),
                    podmanBinary: "podman-bin",
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
    const transport = new LocalWorkerTransport({
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
            workspacePath: "/tmp/workspace"
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
            cwd: "/tmp/workspace",
            env: expectedEnv,
            stdio: ["ignore", "pipe", "pipe"]
        }
    });
});

test("ssh transport uses remote cwd only for start command", async () => {
    const recorder = createSpawnRecorder();
    const transport = new SshWorkerTransport({
        command: "ssh-bin devbox",
        workspace: "/srv/workspaces/task 3",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("start", {
        instanceName: "task-3-ssh",
        workspacePath: "/srv/workspaces/task 3"
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
            shellEscape("cd '/srv/workspaces/task 3' && '/usr/local/bin/devshell-worker' 'start' '--instance' 'task-3-ssh'")
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
            shellEscape("cd '/srv/workspaces/task 3' && '/usr/local/bin/devshell-worker' 'start' '--instance' 'task-3-ssh'")
        ],
        commandDisplay:
            `ssh-bin -oBatchMode=yes -oNumberOfPasswordPrompts=0 -oKbdInteractiveAuthentication=no -oPasswordAuthentication=no devbox -- sh -lc ` +
            shellEscape("cd '/srv/workspaces/task 3' && '/usr/local/bin/devshell-worker' 'start' '--instance' 'task-3-ssh'"),
        cwd: "/srv/workspaces/task 3",
        exitCode: 0,
        instance: "task-3-ssh",
        operation: "start",
        provider: "ssh"
    });
});

test("ssh transport runs installWorker probe via remote shell", async () => {
    const recorder = createSpawnRecorder();
    const transport = new SshWorkerTransport({
        command: "ssh-bin devbox",
        workspace: "/srv/workspaces/task 3",
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
    const transport = new SshWorkerTransport({
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
    const transport = new SshWorkerTransport({
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
    const installer = new RemoteWorkerInstaller({
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

        if (callIndex === 1 || callIndex === 6) {
            closeRecordedChild(child, { stdout: "/home/dev" });
            return true;
        }

        if (callIndex === 2 || callIndex === 7) {
            closeRecordedChild(child, { stdout: "missing" });
            return true;
        }

        if (callIndex === 3 || callIndex === 8) {
            child.stdin.once("finish", () => {
                closeRecordedChild(child);
            });
            return true;
        }

        closeRecordedChild(child);
        return true;
    });
    const transport = new SshWorkerTransport({
        command: "ssh-bin devbox",
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();
    process.env.PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH = secondWorker.path;
    await transport.installWorker();

    assert.equal(Buffer.concat(recorder.children[3]?.stdinChunks ?? []).equals(firstWorker.contents), true);
    assert.equal(Buffer.concat(recorder.children[8]?.stdinChunks ?? []).equals(secondWorker.contents), true);
    assert.notEqual(recorder.calls[3]?.args[8], recorder.calls[8]?.args[8]);
});

test("ssh transport appends interactive-auth hint when batch mode authentication fails", async () => {
    const recorder = createSpawnRecorder((_call, child) => {
        closeRecordedChild(child, {
            code: 255,
            stderr: "Permission denied (publickey,password).\n"
        });
        return true;
    });
    const transport = new SshWorkerTransport({
        command: "ssh demo",
        workspace: "/workspace",
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
    const transport = new SshWorkerTransport({
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
    const transport = new DockerWorkerTransport({
        container: createManagedContainerConfig(),
        dockerBinary: "docker-bin",
        remoteCwd: "/workspace",
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
    const transport = new DockerWorkerTransport({
        container: createManagedContainerConfig(),
        dockerBinary: "docker-bin",
        remoteCwd: "/workspace",
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
    const transport = new DockerWorkerTransport({
        container: createManagedContainerConfig(),
        dockerBinary: "docker-bin",
        remoteCwd: "/workspace",
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
    const transport = new PodmanWorkerTransport({
        container: createManagedContainerConfig(),
        podmanBinary: "podman-bin",
        remoteCwd: "/workspace",
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

test("podman transport runs installWorker probe via exec", async () => {
    const recorder = createSpawnRecorder((call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "running\n" });
            return true;
        }

        return false;
    });
    const transport = new PodmanWorkerTransport({
        container: createManagedContainerConfig(),
        podmanBinary: "podman-bin",
        remoteCwd: "/workspace",
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
    const transport = new PodmanWorkerTransport({
        container: createManagedContainerConfig(),
        podmanBinary: "podman-bin",
        remoteCwd: "/workspace",
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
    const transport = new DockerWorkerTransport({
        container: {
            containerName: "worker-container",
            image: "archlinux:latest",
            mode: "preset",
            preset: "arch"
        },
        dockerBinary: "docker-bin",
        remoteCwd: "/workspace",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("start", {
        instanceName: "task-3-docker",
        workspacePath: "/workspace"
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(recorder.calls[0]?.args, ["inspect", "--type", "container", "--format", "{{.State.Status}}", "worker-container"]);
    assert.deepEqual(recorder.calls[1]?.args.slice(0, 4), ["create", "--name", "worker-container", "archlinux:latest"]);
    assert.deepEqual(recorder.calls[2]?.args, ["start", "worker-container"]);
    assert.deepEqual(recorder.calls[3]?.args, [
        "exec",
        "-w",
        "/workspace",
        "-i",
        "worker-container",
        "/usr/local/bin/devshell-worker",
        "start",
        "--instance",
        "task-3-docker"
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
    const transport = new PodmanWorkerTransport({
        container: {
            adoptLifecycle: true,
            containerName: "worker-container",
            mode: "existingStoppedContainer"
        },
        podmanBinary: "podman-bin",
        remoteCwd: "/workspace",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await assert.rejects(
        transport.runWorkerCommand("start", { instanceName: "task-3-podman", workspacePath: "/workspace" }),
        /Running container attach is not a supported instance mode/u
    );
});

test("local transport executes frozen devshell-worker start status logs stop rpc", async (t) => {
    const workspacePath = await mkdtemp(join(tmpdir(), "portable-devshell-core-"));
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-core-home-"));
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-core-runtime-"));
    const instanceName = `task-3-${process.pid}`;
    const env = { ...process.env, HOME: homeDirectory, XDG_RUNTIME_DIR: runtimeDirectory };
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const transport = new LocalWorkerTransport({
        workerBinary: new WorkerBinary(resolve(repoRoot, "target/debug/devshell-worker")),
        spawnFunction: nodeSpawn
    });

    t.after(async () => {
        await transport.runWorkerCommand("stop", { env, instanceName });
        await rm(homeDirectory, { recursive: true, force: true });
        await rm(workspacePath, { recursive: true, force: true });
        await rm(runtimeDirectory, { recursive: true, force: true });
    });

    await transport.installWorker();

    const startResult = await transport.runWorkerCommand("start", { env, instanceName, workspacePath });
    assert.equal(startResult.exitCode, 0);
    assert.equal(JSON.parse(startResult.stdout).workspace, workspacePath);

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
    assert.deepEqual(await rpcProcess.exit, { code: null, signal: "SIGTERM" });

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

async function createDummyWorkerBinary(): Promise<{
    path: string;
    contents: Buffer;
    cleanup: () => Promise<void>;
}>;
async function createDummyWorkerBinary(tag: string = "remote"): Promise<{
    path: string;
    contents: Buffer;
    cleanup: () => Promise<void>;
}> {
    const directory = await mkdtemp(join(tmpdir(), "portable-devshell-core-worker-"));
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
