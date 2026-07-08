import assert from "node:assert/strict";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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

test("docker transport builds exec command", async () => {
    const recorder = createSpawnRecorder();
    const transport = new DockerWorkerTransport({
        container: "worker-container",
        dockerBinary: "docker-bin",
        remoteCwd: "/workspace",
        workerBinary: new WorkerBinary("devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("logs", { instanceName: "task-3-docker" });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(recorder.calls[0], {
        command: "docker-bin",
        args: ["exec", "-w", "/workspace", "-i", "worker-container", "devshell-worker", "logs", "--instance", "task-3-docker"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
});

test("docker transport runs installWorker probe via exec", async () => {
    const recorder = createSpawnRecorder();
    const transport = new DockerWorkerTransport({
        container: "worker-container",
        dockerBinary: "docker-bin",
        remoteCwd: "/workspace",
        workerBinary: new WorkerBinary("devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();

    assert.deepEqual(recorder.calls[0], {
        command: "docker-bin",
        args: ["exec", "-w", "/workspace", "-i", "worker-container", "devshell-worker", "--version"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
});

test("podman transport builds exec command", async () => {
    const recorder = createSpawnRecorder();
    const transport = new PodmanWorkerTransport({
        container: "worker-container",
        podmanBinary: "podman-bin",
        remoteCwd: "/workspace",
        workerBinary: new WorkerBinary("devshell-worker"),
        spawnFunction: recorder.spawn
    });

    const result = await transport.runWorkerCommand("stop", { instanceName: "task-3-podman" });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(recorder.calls[0], {
        command: "podman-bin",
        args: ["exec", "-w", "/workspace", "-i", "worker-container", "devshell-worker", "stop", "--instance", "task-3-podman"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
});

test("podman transport runs installWorker probe via exec", async () => {
    const recorder = createSpawnRecorder();
    const transport = new PodmanWorkerTransport({
        container: "worker-container",
        podmanBinary: "podman-bin",
        remoteCwd: "/workspace",
        workerBinary: new WorkerBinary("devshell-worker"),
        spawnFunction: recorder.spawn
    });

    await transport.installWorker();

    assert.deepEqual(recorder.calls[0], {
        command: "podman-bin",
        args: ["exec", "-w", "/workspace", "-i", "worker-container", "devshell-worker", "--version"],
        options: { cwd: undefined, env: undefined, stdio: ["ignore", "pipe", "pipe"] }
    });
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

function restoreEnv(name: keyof NodeJS.ProcessEnv, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
}

function createSpawnRecorder(): {
    calls: RecordedCall[];
    children: Array<ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }>;
    spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
} {
    const calls: RecordedCall[] = [];
    const children: Array<ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }> = [];

    return {
        calls,
        children,
        spawn(command, args, options) {
            const stdin = new PassThrough();
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            const child = new EventEmitter() as ChildProcess & {
                stdin: PassThrough;
                stdout: PassThrough;
                stderr: PassThrough;
            };

            child.stdin = stdin;
            child.stdout = stdout;
            child.stderr = stderr;
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
            children.push(child);

            if (options.stdio?.[0] === "ignore") {
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
