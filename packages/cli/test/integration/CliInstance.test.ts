import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Channel, Codec, type Frame, type JsonValue } from "@portable-devshell/shared";

import { CliMain } from "../../dist/cli/CliMain.js";

async function runInstanceCommandsThroughControlRpc(t: { after(callback: () => Promise<void> | void): void }): Promise<void> {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "portable-devshell-cli-instance-"));
    const socketDir = join(runtimeRoot, "portable-devshell");
    const socketPath = join(socketDir, "control.sock");
    await mkdir(socketDir, { recursive: true });
    const harness = createInstanceHarness();
    const server = createServer((socket) => {
        harness.attach(socket);
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });

    t.after(async () => {
        await closeServer(server);
        await rm(runtimeRoot, { force: true, recursive: true });
    });

    const stdout = createBuffer();
    const stderr = createBuffer();
    const cli = new CliMain({
        followEventLimit: 1,
        stderr,
        stdout,
        xdgRuntimeDir: runtimeRoot
    });

    assert.equal(await cli.run(["instance", "list"]), 0);
    assert.match(stdout.flush(), /demo-local\tstopped/u);

    assert.equal(await cli.run(["instance", "status", "demo-local"]), 0);
    assert.match(stdout.flush(), /instance: demo-local/u);

    assert.equal(await cli.run(["instance", "start", "demo-local"]), 0);
    assert.match(stdout.flush(), /status: ready/u);

    assert.equal(await cli.run(["instance", "stop", "demo-local"]), 0);
    assert.match(stdout.flush(), /status: stopped/u);

    assert.equal(await cli.run(["instance", "logs", "demo-local"]), 0);
    assert.equal(stdout.flush(), "[1] stdout before\n");

    assert.equal(await cli.run(["instance", "logs", "demo-local", "-f"]), 0);
    assert.equal(stdout.flush(), "[1] stdout before\n[2] stdout after\n");

    assert.equal(await cli.run(["instance", "call", "demo-local", "bash_run", "{\"command\":\"pwd\"}"]), 0);
    const callOutput = stdout.flush();
    assert.match(callOutput, /tool: bash_run/u);
    assert.match(callOutput, /stdout:\n\/tmp\/ws/u);
    assert.equal(stderr.flush(), "");
}

async function runRealWorkerSmoke(): Promise<void> {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-cli-real-home-"));
    const xdgRuntimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-cli-real-runtime-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "portable-devshell-cli-real-workspace-"));
    const workerBinaryPath = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "target/debug/devshell-worker");
    const stdout = createBuffer();
    const stderr = createBuffer();
    const workerEnvName = hostWorkerEnvName();
    const previousWorkerPath = process.env[workerEnvName];
    let controlStopped = false;
    const cli = new CliMain({
        homeDirectory,
        stderr,
        stdout,
        xdgRuntimeDir
    });

    process.env[workerEnvName] = workerBinaryPath;

    await mkdir(join(homeDirectory, ".devshell", "control"), { recursive: true });
    await mkdir(join(homeDirectory, ".devshell", "control", "instances"), { recursive: true });
    await writeFile(
        join(homeDirectory, ".devshell", "control", "config.toml"),
        createRealConfig(),
        "utf8"
    );
    await writeFile(
        join(homeDirectory, ".devshell", "control", "instances", "aromatic-pc.toml"),
        createLocalInstanceConfig("aromatic-pc", workspacePath),
        "utf8"
    );
    let controlPid: number | undefined;

    try {
        assert.equal(await cli.run(["start"]), 0);
        assert.match(stdout.flush(), /control: running/u);
        controlPid = await readControlPid(homeDirectory);

        assert.equal(await cli.run(["status"]), 0);
        assert.match(stdout.flush(), /instances: 1/u);

        assert.equal(await cli.run(["instance", "list"]), 0);
        assert.match(stdout.flush(), /aromatic-pc\tstopped/u);

        assert.equal(await cli.run(["instance", "status", "aromatic-pc"]), 0);
        assert.match(stdout.flush(), /status: stopped/u);

        assert.equal(await cli.run(["instance", "start", "aromatic-pc"]), 0);
        assert.match(stdout.flush(), /status: ready/u);

        assert.equal(await cli.run(["instance", "status", "aromatic-pc"]), 0);
        assert.match(stdout.flush(), /ready: true/u);

        assert.equal(await cli.run(["instance", "call", "aromatic-pc", "bash_run", "{\"command\":\"pwd\"}"]), 0);
        const pwdOutput = stdout.flush();
        assert.match(pwdOutput, new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

        assert.equal(
            await cli.run(["instance", "call", "aromatic-pc", "bash_run", "{\"command\":\"echo portable-devshell\"}"]),
            0
        );
        assert.match(stdout.flush(), /portable-devshell/u);

        assert.equal(await cli.run(["instance", "logs", "aromatic-pc"]), 0);
        const logsOutput = stdout.flush();
        assert.match(logsOutput, /portable-devshell/u);
        assert.match(logsOutput, new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

        assert.equal(await cli.run(["stop"]), 0);
        controlStopped = true;
        await waitForControlShutdown(xdgRuntimeDir);
        await ensureProcessExit(controlPid);
        assert.equal(stdout.flush(), "control: stopped\n");
        assert.equal(stderr.flush(), "");

        const auditDatabase = await stat(join(homeDirectory, ".devshell", "aromatic-pc", "control-worker", "audit.sqlite3"));
        assert.equal(auditDatabase.size > 0, true);
    } finally {
        if (!controlStopped) {
            await cli.run(["stop"]).catch(() => undefined);
            await waitForControlShutdown(xdgRuntimeDir).catch(() => undefined);
        }
        await ensureProcessExit(controlPid).catch(() => undefined);
        restoreEnv(workerEnvName, previousWorkerPath);
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(xdgRuntimeDir, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
    }
}

async function runInteractiveCreateFlow(t: { after(callback: () => Promise<void> | void): void }): Promise<void> {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-cli-create-home-"));
    const xdgRuntimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-cli-create-runtime-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "portable-devshell-cli-create-workspace-"));
    const workerBinaryPath = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "target/debug/devshell-worker");
    const stdout = createBuffer();
    const stderr = createBuffer();
    const workerEnvName = hostWorkerEnvName();
    const previousWorkerPath = process.env[workerEnvName];
    let controlStopped = false;
    const cli = new CliMain({
        homeDirectory,
        stderr,
        stdin: Readable.from([
            "aromatic-pc\n",
            "\n",
            "\n",
            `${workspacePath}\n`,
            "\n",
            "\n",
            "\n",
            "\n",
            "\n"
        ]),
        stdout,
        xdgRuntimeDir
    });

    process.env[workerEnvName] = workerBinaryPath;

    await mkdir(join(homeDirectory, ".devshell", "control"), { recursive: true });
    await mkdir(join(homeDirectory, ".devshell", "control", "instances"), { recursive: true });
    await writeFile(join(homeDirectory, ".devshell", "control", "config.toml"), createCreateConfig(), "utf8");
    let controlPid: number | undefined = undefined;

    t.after(async () => {
        if (!controlStopped) {
            await cli.run(["stop"]).catch(() => undefined);
            await waitForControlShutdown(xdgRuntimeDir).catch(() => undefined);
        }
        await ensureProcessExit(controlPid).catch(() => undefined);
        restoreEnv(workerEnvName, previousWorkerPath);
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(xdgRuntimeDir, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
    });

    assert.equal(await cli.run(["start"]), 0);
    assert.match(stdout.flush(), /control: running/u);
    controlPid = await readControlPid(homeDirectory);

    assert.equal(await cli.run(["instance", "create"]), 0);
    const createOutput = stdout.flush();
    assert.match(createOutput, /Summary/u);
    assert.match(createOutput, /instance created: aromatic-pc/u);
    assert.doesNotMatch(createOutput, /worker binary path:/u);

    assert.equal(await cli.run(["instance", "list"]), 0);
    assert.match(stdout.flush(), /aromatic-pc\tstopped/u);

    assert.equal(await cli.run(["instance", "start", "aromatic-pc"]), 0);
    assert.match(stdout.flush(), /status: ready/u);

    assert.equal(await cli.run(["instance", "call", "aromatic-pc", "bash_run", "{\"command\":\"pwd\"}"]), 0);
    assert.match(stdout.flush(), new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

    assert.doesNotMatch(await readFile(join(homeDirectory, ".devshell", "control", "config.toml"), "utf8"), /\[\[instances\]\]/u);
    assert.match(
        await readFile(join(homeDirectory, ".devshell", "control", "instances", "aromatic-pc.toml"), "utf8"),
        /name = "aromatic-pc"/u
    );
    assert.doesNotMatch(await readFile(join(homeDirectory, ".devshell", "control", "config.toml"), "utf8"), /workerBinaryPath/u);

    assert.equal(await cli.run(["stop"]), 0);
    controlStopped = true;
    await waitForControlShutdown(xdgRuntimeDir);
    await ensureProcessExit(controlPid);
    assert.equal(stdout.flush(), "control: stopped\n");
    assert.equal(stderr.flush(), "");
}

test("CliInstance integration", async (t) => {
    await t.test("CliMain covers Task 11 instance commands through control rpc", async (subtest) => {
        await runInstanceCommandsThroughControlRpc(subtest);
    });
    await t.test("CliMain runs Task 12 real worker smoke through control lifecycle", async () => {
        await runRealWorkerSmoke();
    });
    await t.test("CliMain creates an instance interactively and uses it through the real control lifecycle", async (subtest) => {
        await runInteractiveCreateFlow(subtest);
    });
});

function createInstanceHarness(): { attach: (socket: Socket) => void } {
    return {
        attach(socket: Socket) {
            const codec = new Codec(Channel.accept(socket), { local: "server" });
            codec.onFrame((frame) => {
                void handleHarnessFrame(codec, frame).catch(() => undefined);
            });
        }
    };
}

async function handleHarnessFrame(codec: Codec, frame: Frame): Promise<void> {
    switch (frame.event.name) {
        case "instance.list":
            await reply(codec, frame, [
                {
                    mcpEnabled: true,
                    name: "demo-local",
                    snapshot: stoppedSnapshot()
                }
            ]);
            return;
        case "runtime.snapshot":
        case "runtime.refresh":
            await reply(codec, frame, { lastSeq: 1, snapshot: stoppedSnapshot() });
            return;
        case "runtime.start":
            await codec.send({
                id: `ack-${frame.id}`,
                replyTo: frame.id,
                streamId: frame.id,
                event: {
                    destination: frame.event.destination,
                    name: frame.event.name,
                    payload: { accepted: true }
                }
            });
            await codec.send({
                id: `complete-${frame.id}`,
                streamId: frame.id,
                event: {
                    destination: frame.event.destination,
                    name: "stream.completed",
                    payload: readySnapshot()
                }
            });
            return;
        case "runtime.stop":
            await reply(codec, frame, stoppedSnapshot());
            return;
        case "runtime.readLogs":
            await reply(
                codec,
                frame,
                isRecord(frame.event.payload) && frame.event.payload.fromSeq === 2
                    ? [{ at: "", instanceName: "demo-local", message: "after\n", seq: 2, stream: "stdout" }]
                    : [{ at: "", instanceName: "demo-local", message: "before\n", seq: 1, stream: "stdout" }]
            );
            return;
        case "runtime.subscribe":
            await codec.send({
                id: `ack-${frame.id}`,
                replyTo: frame.id,
                streamId: frame.id,
                event: {
                    destination: frame.event.destination,
                    name: frame.event.name,
                    payload: { events: [], lastSeq: 1 }
                }
            });
            setTimeout(() => {
                void codec.send({
                    id: `event-${frame.id}`,
                    streamId: frame.id,
                    event: {
                        destination: frame.event.destination,
                        name: "toolCall.completed",
                        payload: {
                            at: "",
                            data: { toolName: "bash_run" },
                            instanceName: "demo-local",
                            seq: 2,
                            type: "toolCall.completed"
                        },
                        seq: 2
                    }
                }).catch(() => undefined);
            }, 5);
            return;
        case "tool.call":
            await reply(codec, frame, { exitCode: 0, stderr: "", stdout: "/tmp/ws\n" });
            return;
        default:
            await codec.send({
                id: `error-${frame.id}`,
                replyTo: frame.id,
                event: {
                    destination: frame.event.destination,
                    name: frame.event.name,
                    error: {
                        code: "control.methodNotFound",
                        message: `unknown operation ${frame.event.name}`,
                        retryable: false
                    }
                }
            });
    }
}

async function reply(codec: Codec, frame: Frame, payload: JsonValue): Promise<void> {
    await codec.send({
        id: `reply-${frame.id}`,
        replyTo: frame.id,
        event: {
            destination: frame.event.destination,
            name: frame.event.name,
            payload
        }
    });
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stoppedSnapshot() {
    return {
        connectionState: "disconnected",
        daemonState: "stopped",
        lastSeq: 1,
        name: "demo-local",
        ready: false,
        status: "stopped"
    };
}

function readySnapshot() {
    return {
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 2,
        name: "demo-local",
        ready: true,
        status: "ready"
    };
}

function createBuffer(): { flush: () => string; write: (chunk: string) => void } {
    const chunks: string[] = [];

    return {
        flush() {
            const value = chunks.join("");
            chunks.length = 0;
            return value;
        },
        write(chunk: string) {
            chunks.push(chunk);
        }
    };
}

function createRealConfig(): string {
    return [
        "version = 1",
        "",
        "[control]",
        'logLevel = "info"',
        "",
        "[mcp]",
        "enabled = false",
        'listenHost = "127.0.0.1"',
        "listenPort = 17890",
        "",
        "[mcp.auth]",
        'mode = "none"',
        ""
    ].join("\n");
}

function createCreateConfig(): string {
    return [
        "version = 1",
        "",
        "[control]",
        'logLevel = "info"',
        "",
        "[mcp]",
        "enabled = false",
        'listenHost = "127.0.0.1"',
        "listenPort = 17890",
        'publicBaseUrl = "http://127.0.0.1:17890"',
        "",
        "[mcp.auth]",
        'mode = "none"',
        ""
    ].join("\n");
}

function createLocalInstanceConfig(name: string, workspacePath: string): string {
    return [
        "version = 2",
        `name = ${JSON.stringify(name)}`,
        "enabled = true",
        'provider = "local"',
        `workspace = ${JSON.stringify(workspacePath)}`,
        "",
        "[mcp]",
        "enabled = false",
        "",
        "[mcp.tools]",
        'groups = ["file", "bash", "artifact"]',
        'capabilities = ["read", "write", "execute"]',
        "",
        "[logs]",
        "eventBufferSize = 50",
        ""
    ].join("\n");
}

async function readControlPid(homeDirectory: string): Promise<number | undefined> {
    try {
        const source = (await readFile(join(homeDirectory, ".devshell", "control", "control.pid"), "utf8")).trim();
        const pid = Number.parseInt(source, 10);
        return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
        return undefined;
    }
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    const origin = captureStack("closeServer");
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error !== undefined) {
                reject(appendTimeoutOrigin(error, origin));
                return;
            }

            resolve();
        });
    });
}

async function waitForControlShutdown(xdgRuntimeDir: string, timeoutMs = 3_000): Promise<void> {
    const origin = captureStack(`waitForControlShutdown(${xdgRuntimeDir})`);
    const socketPath = join(xdgRuntimeDir, "portable-devshell", "control.sock");
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            await access(socketPath);
        } catch {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(`timed out waiting for control shutdown at ${socketPath}\n${origin}`);
}

async function ensureProcessExit(pid: number | undefined, timeoutMs = 3_000): Promise<void> {
    if (pid === undefined) {
        return;
    }

    const origin = captureStack(`ensureProcessExit(${pid})`);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        } catch (error) {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
                return;
            }

            throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    process.kill(pid, "SIGKILL");

    for (let attempts = 0; attempts < 50; attempts += 1) {
        try {
            process.kill(pid, 0);
        } catch (error) {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
                return;
            }

            throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(`timed out waiting for process ${pid} to exit after SIGKILL\n${origin}`);
}

function captureStack(label: string): string {
    return new Error(`Timeout origin: ${label}`).stack ?? `Timeout origin: ${label}`;
}

function appendTimeoutOrigin(error: unknown, origin: string): Error {
    if (error instanceof Error) {
        error.stack = `${error.stack ?? `${error.name}: ${error.message}`}\n${origin}`;
        return error;
    }

    return new Error(`${String(error)}\n${origin}`);
}

function restoreEnv(name: keyof NodeJS.ProcessEnv, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
}

function hostWorkerEnvName(): keyof NodeJS.ProcessEnv {
    return `PORTABLE_DEVSHELL_WORKER_${normalizePlatform(process.platform)}_${normalizeArch(process.arch)}_PATH`;
}

function normalizePlatform(platform: NodeJS.Platform): string {
    switch (platform) {
        case "linux":
            return "LINUX";
        case "darwin":
            return "DARWIN";
        default:
            throw new Error(`unsupported platform in test: ${platform}`);
    }
}

function normalizeArch(arch: string): string {
    switch (arch) {
        case "x64":
            return "X64";
        case "arm64":
            return "ARM64";
        default:
            throw new Error(`unsupported architecture in test: ${arch}`);
    }
}
