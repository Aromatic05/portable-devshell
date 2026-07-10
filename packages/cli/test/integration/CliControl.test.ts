import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FrameReader, FrameWriter, type JsonValue } from "@portable-devshell/shared";

import { CliControlClient } from "../../dist/cli/control/CliControlClient.js";
import { CliMain } from "../../dist/cli/CliMain.js";

test("CliControlClient performs control rpc over unix socket", async (t) => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "portable-devshell-cli-control-"));
    const socketDir = join(runtimeRoot, "portable-devshell");
    const socketPath = join(socketDir, "control.sock");
    await mkdir(socketDir, { recursive: true });
    const methods: string[] = [];
    const server = createServer((socket) => {
        const reader = new FrameReader();
        const writer = new FrameWriter(socket);

        socket.on("data", (chunk: Uint8Array) => {
            for (const frame of reader.push(chunk)) {
                const envelope = frame as Record<string, any>;
                methods.push(String(envelope.method));

                void writer.write({
                    id: envelope.id,
                    ok: true,
                    result:
                        envelope.method === "control.identifyClient"
                            ? {
                                  clientKind: envelope.params?.clientKind,
                                  ok: true
                              }
                            : envelope.method === "control.listInstances"
                            ? [
                                  {
                                      mcpEnabled: true,
                                      name: "demo-local",
                                      snapshot: {
                                          connectionState: "disconnected",
                                          daemonState: "stopped",
                                          lastSeq: 0,
                                          name: "demo-local",
                                          ready: false,
                                          status: "stopped"
                                      }
                                  }
                              ]
                            : envelope.method === "instance.readToolCalls"
                              ? [
                                    {
                                        callId: "call-1",
                                        completedAt: "2026-07-08T00:00:01.000Z",
                                        exitCode: 0,
                                        inputSummary: "{\"command\":\"pwd\"}",
                                        instance: "demo-local",
                                        source: "cli",
                                        startedAt: "2026-07-08T00:00:00.000Z",
                                        status: "completed",
                                        stderrBytes: 0,
                                        stdoutBytes: 8,
                                        termination: "exited",
                                        toolName: "bash_run"
                                    }
                                ]
                            : null,
                    type: "response"
                } as unknown as JsonValue);
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });

    t.after(async () => {
        server.close();
        await rm(runtimeRoot, { force: true, recursive: true });
    });

    const client = new CliControlClient({ socketPath });
    const instances = await client.listInstances();
    const toolCalls = await client.readToolCalls("demo-local", { limit: 1, status: "completed" });

    assert.equal(instances[0]?.name, "demo-local");
    assert.equal(instances[0]?.snapshot.status, "stopped");
    assert.equal(toolCalls[0]?.instance, "demo-local");
    assert.equal(toolCalls[0]?.toolName, "bash_run");
    assert.deepEqual(methods, ["control.identifyClient", "control.listInstances", "control.identifyClient", "instance.readToolCalls"]);
});

test("CliMain reports control not running without auto-starting it", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "portable-devshell-cli-missing-"));
    const stdout = createBuffer();
    const stderr = createBuffer();
    const cli = new CliMain({
        stderr,
        stdout,
        xdgRuntimeDir: runtimeRoot
    });

    try {
        const exitCode = await cli.run(["instance", "list"]);
        assert.equal(exitCode, 3);
        assert.equal(stdout.flush(), "");
        assert.match(stderr.flush(), /devshell start/u);
    } finally {
        await rm(runtimeRoot, { force: true, recursive: true });
    }
});

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
