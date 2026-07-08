import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FrameReader, FrameWriter, type JsonValue } from "@portable-devshell/shared";

import { CliMain } from "../../dist/cli/CliMain.js";

test("CliMain covers Task 11 instance commands through control rpc", async (t) => {
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
        server.close();
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
});

test("CliMain runs Task 12 real worker smoke through control lifecycle", async (t) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-cli-real-home-"));
    const xdgRuntimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-cli-real-runtime-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "portable-devshell-cli-real-workspace-"));
    const workerBinaryPath = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "target/debug/devshell-worker");
    const stdout = createBuffer();
    const stderr = createBuffer();
    let controlStopped = false;
    const cli = new CliMain({
        homeDirectory,
        stderr,
        stdout,
        xdgRuntimeDir
    });

    await mkdir(join(homeDirectory, ".devshell", "control"), { recursive: true });
    await writeFile(
        join(homeDirectory, ".devshell", "control", "config.toml"),
        createRealConfig(workspacePath, workerBinaryPath),
        "utf8"
    );

    t.after(async () => {
        if (!controlStopped) {
            await cli.run(["stop"]).catch(() => undefined);
        }
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(xdgRuntimeDir, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
    });

    assert.equal(await cli.run(["start"]), 0);
    assert.match(stdout.flush(), /control: running/u);

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
    assert.equal(stdout.flush(), "control: stopped\n");
    assert.equal(stderr.flush(), "");

    assert.match(await readFile(join(homeDirectory, ".devshell", "aromatic-pc", "control-worker", "tool-calls.jsonl"), "utf8"), /bash_run/u);
});

test("CliMain creates an instance interactively and uses it through the real control lifecycle", async (t) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-cli-create-home-"));
    const xdgRuntimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-cli-create-runtime-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "portable-devshell-cli-create-workspace-"));
    const workerBinaryPath = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "target/debug/devshell-worker");
    const stdout = createBuffer();
    const stderr = createBuffer();
    let controlStopped = false;
    const cli = new CliMain({
        homeDirectory,
        stderr,
        stdin: Readable.from([
            "aromatic-pc\n",
            "\n",
            "\n",
            `${workspacePath}\n`,
            `${workerBinaryPath}\n`,
            "\n",
            "\n",
            "\n",
            "\n",
            "\n",
            "\n",
            "\n"
        ]),
        stdout,
        xdgRuntimeDir
    });

    await mkdir(join(homeDirectory, ".devshell", "control"), { recursive: true });
    await writeFile(join(homeDirectory, ".devshell", "control", "config.toml"), createCreateConfig(), "utf8");

    t.after(async () => {
        if (!controlStopped) {
            await cli.run(["stop"]).catch(() => undefined);
        }
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(xdgRuntimeDir, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
    });

    assert.equal(await cli.run(["start"]), 0);
    assert.match(stdout.flush(), /control: running/u);

    assert.equal(await cli.run(["instance", "create"]), 0);
    const createOutput = stdout.flush();
    assert.match(createOutput, /Summary/u);
    assert.match(createOutput, /instance created: aromatic-pc/u);

    assert.equal(await cli.run(["instance", "list"]), 0);
    assert.match(stdout.flush(), /aromatic-pc\tstopped/u);

    assert.equal(await cli.run(["instance", "start", "aromatic-pc"]), 0);
    assert.match(stdout.flush(), /status: ready/u);

    assert.equal(await cli.run(["instance", "call", "aromatic-pc", "bash_run", "{\"command\":\"pwd\"}"]), 0);
    assert.match(stdout.flush(), new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

    assert.match(await readFile(join(homeDirectory, ".devshell", "control", "config.toml"), "utf8"), /\[\[instances\]\]/u);
    assert.match(await readFile(join(homeDirectory, ".devshell", "control", "config.toml"), "utf8"), /name = "aromatic-pc"/u);

    assert.equal(await cli.run(["stop"]), 0);
    controlStopped = true;
    assert.equal(stdout.flush(), "control: stopped\n");
    assert.equal(stderr.flush(), "");
});

function createInstanceHarness(): { attach: (socket: Socket) => void } {
    return {
        attach(socket: Socket) {
            const reader = new FrameReader();
            const writer = new FrameWriter(socket);

            socket.on("data", (chunk: Uint8Array) => {
                for (const frame of reader.push(chunk)) {
                    const envelope = frame as Record<string, any>;

                    switch (envelope.method) {
                        case "control.listInstances":
                            void respond(writer, envelope.id, [
                                {
                                    mcpEnabled: true,
                                    name: "demo-local",
                                    snapshot: stoppedSnapshot()
                                }
                            ]);
                            break;
                        case "instance.getSnapshot":
                        case "instance.refreshStatus":
                            void respond(writer, envelope.id, {
                                lastSeq: 1,
                                snapshot: stoppedSnapshot()
                            });
                            break;
                        case "instance.start":
                            void respond(writer, envelope.id, readySnapshot());
                            break;
                        case "instance.stop":
                            void respond(writer, envelope.id, stoppedSnapshot());
                            break;
                        case "instance.readLogs":
                            void respond(
                                writer,
                                envelope.id,
                                envelope.params?.fromSeq === 2
                                    ? [{ at: "", instanceName: "demo-local", message: "after\n", seq: 2, stream: "stdout" }]
                                    : [{ at: "", instanceName: "demo-local", message: "before\n", seq: 1, stream: "stdout" }]
                            );
                            break;
                        case "instance.subscribe":
                            void respond(writer, envelope.id, { events: [], lastSeq: 1 }).then(() => {
                                setTimeout(() => {
                                    void writer.write({
                                        event: "toolCall.completed",
                                        payload: {
                                            at: "",
                                            data: { toolName: "bash_run" },
                                            instanceName: "demo-local",
                                            seq: 2,
                                            type: "toolCall.completed"
                                        },
                                        seq: 2,
                                        target: { instance: "demo-local", kind: "instance" },
                                        type: "event"
                                    } as unknown as JsonValue);
                                }, 5);
                            });
                            break;
                        case "instance.callTool":
                            void respond(writer, envelope.id, { exitCode: 0, stderr: "", stdout: "/tmp/ws\n" });
                            break;
                        default:
                            void writer.write({
                                error: { code: "control.methodNotFound", message: `unknown method ${envelope.method}`, retryable: false },
                                id: envelope.id,
                                ok: false,
                                type: "response"
                            } as unknown as JsonValue);
                    }
                }
            });
        }
    };
}

async function respond(writer: FrameWriter, id: string, result: unknown): Promise<void> {
    await writer.write({
        id,
        ok: true,
        result,
        type: "response"
    } as unknown as JsonValue);
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

function createRealConfig(workspacePath: string, workerBinaryPath: string): string {
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
        "",
        "[[instances]]",
        'name = "aromatic-pc"',
        "enabled = true",
        'provider = "local"',
        `defaultWorkspace = ${JSON.stringify(workspacePath)}`,
        `workerBinaryPath = ${JSON.stringify(workerBinaryPath)}`,
        "",
        "[instances.mcp]",
        "enabled = false",
        'allowTools = ["bash_run"]',
        "",
        "[instances.logs]",
        "eventBufferSize = 50",
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
