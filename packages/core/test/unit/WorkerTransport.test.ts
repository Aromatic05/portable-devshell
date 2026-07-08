import assert from "node:assert/strict";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    DockerWorkerTransport,
    LocalWorkerTransport,
    PodmanWorkerTransport,
    SshWorkerTransport,
    WorkerBinary
} from "@portable-devshell/core";

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
    assert.deepEqual(recorder.calls[0]?.options.env, { ...process.env });
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
    assert.deepEqual(recorder.calls[1]?.options.env, { ...process.env });
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
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
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
                    host: "devbox",
                    sshBinary: "ssh-bin",
                    workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
                    spawnFunction
                }),
            expectedCommandPart: "ssh-bin",
            provider: "ssh"
        },
        {
            build: (spawnFunction: SpawnFunctionLike) =>
                new DockerWorkerTransport({
                    container: "worker-container",
                    dockerBinary: "docker-bin",
                    workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
                    spawnFunction
                }),
            expectedCommandPart: "docker-bin",
            provider: "docker"
        },
        {
            build: (spawnFunction: SpawnFunctionLike) =>
                new PodmanWorkerTransport({
                    container: "worker-container",
                    podmanBinary: "podman-bin",
                    workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
                    spawnFunction
                }),
            expectedCommandPart: "podman-bin",
            provider: "podman"
        }
    ] as const;

    for (const testCase of cases) {
        const recorder = createSpawnRecorder((_call, child) => {
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
        ...process.env,
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

test("ssh transport includes remote cwd in command", async () => {
    const recorder = createSpawnRecorder();
    const transport = new SshWorkerTransport({
        host: "devbox",
        remoteCwd: "/srv/workspaces/task 3",
        sshBinary: "ssh-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("status", { instanceName: "task-3-ssh" });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(recorder.calls[0], {
        command: "ssh-bin",
        args: [
            "devbox",
            "--",
            "sh",
            "-lc",
            "cd '/srv/workspaces/task 3' && '/usr/local/bin/devshell-worker' 'status' '--instance' 'task-3-ssh'"
        ],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(result.details, {
        command: ["ssh-bin", "devbox", "--", "sh", "-lc", "cd '/srv/workspaces/task 3' && '/usr/local/bin/devshell-worker' 'status' '--instance' 'task-3-ssh'"],
        commandDisplay: `ssh-bin devbox -- sh -lc ${JSON.stringify("cd '/srv/workspaces/task 3' && '/usr/local/bin/devshell-worker' 'status' '--instance' 'task-3-ssh'")}`,
        cwd: "/srv/workspaces/task 3",
        exitCode: 0,
        instance: "task-3-ssh",
        operation: "status",
        provider: "ssh"
    });
});

test("ssh transport runs installWorker probe via remote shell", async () => {
    const recorder = createSpawnRecorder();
    const transport = new SshWorkerTransport({
        host: "devbox",
        remoteCwd: "/srv/workspaces/task 3",
        sshBinary: "ssh-bin",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();

    assert.deepEqual(recorder.calls[0], {
        command: "ssh-bin",
        args: [
            "devbox",
            "--",
            "sh",
            "-lc",
            "cd '/srv/workspaces/task 3' && '/usr/local/bin/devshell-worker' '--version'"
        ],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
});

test("ssh transport installs default worker into remote home before probing", async (t) => {
    const worker = await createDummyWorkerBinary();
    t.after(worker.cleanup);
    const previousWorkerPath = process.env.PORTABLE_DEVSHELL_WORKER_PATH;
    process.env.PORTABLE_DEVSHELL_WORKER_PATH = worker.path;
    t.after(() => {
        restoreEnv("PORTABLE_DEVSHELL_WORKER_PATH", previousWorkerPath);
    });

    const recorder = createSpawnRecorder((call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "/home/dev" });
            return true;
        }

        if (callIndex === 1) {
            child.stdin.once("end", () => {
                closeRecordedChild(child);
            });
            return true;
        }

        return false;
    });
    const transport = new SshWorkerTransport({
        host: "devbox",
        sshBinary: "ssh-bin",
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();

    assert.deepEqual(recorder.calls[0], {
        command: "ssh-bin",
        args: ["devbox", "--", "sh", "-lc", 'printf %s "${HOME:?HOME is required to install the worker}"'],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.equal(recorder.calls[1]?.command, "ssh-bin");
    assert.equal(recorder.calls[1]?.args[4]?.includes("/home/dev/.devshell/workers/"), true);
    assert.equal(recorder.calls[1]?.args[4]?.includes('ln -snf "$symlink_target" "$symlink_path"'), true);
    assert.deepEqual(recorder.calls[2], {
        command: "ssh-bin",
        args: ["devbox", "--", "sh", "-lc", "'/home/dev/.devshell/bin/devshell-worker' '--version'"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(Buffer.concat(recorder.children[1]?.stdinChunks ?? []), worker.contents);
});

test("docker transport builds exec command", async () => {
    const recorder = createSpawnRecorder();
    const transport = new DockerWorkerTransport({
        container: "worker-container",
        dockerBinary: "docker-bin",
        remoteCwd: "/workspace",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("logs", { instanceName: "task-3-docker" });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(recorder.calls[0], {
        command: "docker-bin",
        args: ["exec", "-w", "/workspace", "-i", "worker-container", "/usr/local/bin/devshell-worker", "logs", "--instance", "task-3-docker"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
});

test("docker transport runs installWorker probe via exec", async () => {
    const recorder = createSpawnRecorder();
    const transport = new DockerWorkerTransport({
        container: "worker-container",
        dockerBinary: "docker-bin",
        remoteCwd: "/workspace",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();

    assert.deepEqual(recorder.calls[0], {
        command: "docker-bin",
        args: ["exec", "-w", "/workspace", "-i", "worker-container", "/usr/local/bin/devshell-worker", "--version"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
});

test("docker transport installs default worker before exec command", async (t) => {
    const worker = await createDummyWorkerBinary();
    t.after(worker.cleanup);
    const previousWorkerPath = process.env.PORTABLE_DEVSHELL_WORKER_PATH;
    process.env.PORTABLE_DEVSHELL_WORKER_PATH = worker.path;
    t.after(() => {
        restoreEnv("PORTABLE_DEVSHELL_WORKER_PATH", previousWorkerPath);
    });

    const recorder = createSpawnRecorder((call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "/home/dev" });
            return true;
        }

        if (callIndex === 1) {
            child.stdin.once("end", () => {
                closeRecordedChild(child);
            });
            return true;
        }

        return false;
    });
    const transport = new DockerWorkerTransport({
        container: "worker-container",
        dockerBinary: "docker-bin",
        remoteCwd: "/workspace",
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("logs", { instanceName: "task-3-docker" });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(recorder.calls[0], {
        command: "docker-bin",
        args: ["exec", "-i", "worker-container", "sh", "-lc", 'printf %s "${HOME:?HOME is required to install the worker}"'],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.equal(recorder.calls[1]?.args[5]?.includes("/home/dev/.devshell/workers/"), true);
    assert.deepEqual(recorder.calls[2], {
        command: "docker-bin",
        args: [
            "exec",
            "-w",
            "/workspace",
            "-i",
            "worker-container",
            "/home/dev/.devshell/bin/devshell-worker",
            "logs",
            "--instance",
            "task-3-docker"
        ],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.deepEqual(Buffer.concat(recorder.children[1]?.stdinChunks ?? []), worker.contents);
});

test("podman transport builds exec command", async () => {
    const recorder = createSpawnRecorder();
    const transport = new PodmanWorkerTransport({
        container: "worker-container",
        podmanBinary: "podman-bin",
        remoteCwd: "/workspace",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("stop", { instanceName: "task-3-podman" });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(recorder.calls[0], {
        command: "podman-bin",
        args: ["exec", "-w", "/workspace", "-i", "worker-container", "/usr/local/bin/devshell-worker", "stop", "--instance", "task-3-podman"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
});

test("podman transport runs installWorker probe via exec", async () => {
    const recorder = createSpawnRecorder();
    const transport = new PodmanWorkerTransport({
        container: "worker-container",
        podmanBinary: "podman-bin",
        remoteCwd: "/workspace",
        workerBinary: new WorkerBinary("/usr/local/bin/devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();

    assert.deepEqual(recorder.calls[0], {
        command: "podman-bin",
        args: ["exec", "-w", "/workspace", "-i", "worker-container", "/usr/local/bin/devshell-worker", "--version"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
});

test("podman transport installs default worker before spawning rpc", async (t) => {
    const worker = await createDummyWorkerBinary();
    t.after(worker.cleanup);
    const previousWorkerPath = process.env.PORTABLE_DEVSHELL_WORKER_PATH;
    process.env.PORTABLE_DEVSHELL_WORKER_PATH = worker.path;
    t.after(() => {
        restoreEnv("PORTABLE_DEVSHELL_WORKER_PATH", previousWorkerPath);
    });

    const recorder = createSpawnRecorder((call, child, callIndex) => {
        if (callIndex === 0) {
            closeRecordedChild(child, { stdout: "/home/dev" });
            return true;
        }

        if (callIndex === 1) {
            child.stdin.once("end", () => {
                closeRecordedChild(child);
            });
            return true;
        }

        return false;
    });
    const transport = new PodmanWorkerTransport({
        container: "worker-container",
        podmanBinary: "podman-bin",
        remoteCwd: "/workspace",
        spawnFunction: recorder.spawn
    });

    const rpcProcess = await transport.spawnWorkerRpc({ instanceName: "task-3-podman" });

    assert.equal(rpcProcess.stdin, recorder.children[2]?.stdin);
    assert.equal(rpcProcess.stdout, recorder.children[2]?.stdout);
    assert.equal(rpcProcess.stderr, recorder.children[2]?.stderr);
    assert.deepEqual(recorder.calls[0], {
        command: "podman-bin",
        args: ["exec", "-i", "worker-container", "sh", "-lc", 'printf %s "${HOME:?HOME is required to install the worker}"'],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
    assert.equal(recorder.calls[1]?.args[5]?.includes("/home/dev/.devshell/workers/"), true);
    assert.deepEqual(recorder.calls[2], {
        command: "podman-bin",
        args: [
            "exec",
            "-w",
            "/workspace",
            "-i",
            "worker-container",
            "/home/dev/.devshell/bin/devshell-worker",
            "rpc",
            "--instance",
            "task-3-podman"
        ],
        options: { cwd: undefined, env: undefined, stdio: ["pipe", "pipe", "pipe"] }
    });
    assert.deepEqual(Buffer.concat(recorder.children[1]?.stdinChunks ?? []), worker.contents);
    assert.equal(rpcProcess.kill("SIGTERM"), true);
    assert.deepEqual(await rpcProcess.exit, { code: null, signal: "SIGTERM" });
});

test("local transport executes frozen devshell-worker start status logs stop rpc", async (t) => {
    const workspacePath = await mkdtemp(join(tmpdir(), "portable-devshell-core-"));
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-core-home-"));
    const instanceName = `task-3-${process.pid}`;
    const env = { ...process.env, HOME: homeDirectory };
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const transport = new LocalWorkerTransport({
        workerBinary: new WorkerBinary(resolve(repoRoot, "target/debug/devshell-worker")),
        spawnFunction: nodeSpawn
    });

    t.after(async () => {
        await transport.runWorkerCommand("stop", { env, instanceName });
        await rm(homeDirectory, { recursive: true, force: true });
        await rm(workspacePath, { recursive: true, force: true });
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
            const child = new EventEmitter() as RecordedChild;

            child.stdin = stdin;
            child.stdout = stdout;
            child.stderr = stderr;
            child.stdinChunks = stdinChunks;
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
}> {
    const directory = await mkdtemp(join(tmpdir(), "portable-devshell-core-worker-"));
    const path = join(directory, "devshell-worker");
    const contents = Buffer.from("#!/bin/sh\necho remote worker\n", "utf8");

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
