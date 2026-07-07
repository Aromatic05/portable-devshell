import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
                                        event: "instance.toolCalled",
                                        payload: {
                                            at: "",
                                            data: { toolName: "bash_run" },
                                            instanceName: "demo-local",
                                            seq: 2,
                                            type: "instance.toolCalled"
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
                                error: { code: "protocol.envelope_invalid", message: `unknown method ${envelope.method}`, retryable: false },
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
