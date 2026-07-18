import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Channel, Codec, type JsonValue } from "@portable-devshell/shared";

import { createCliClients } from "../../src/client/CliClientComposition.ts";
import { createTestIpcPath } from "../../../../test/TestPlatformSupport.ts";
import { CliMain } from "../../src/CliMain.ts";

test("module CLI clients perform control rpc over unix socket", async (t) => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "portable-devshell-cli-control-"));
    const socketPath = createTestIpcPath("cli-control", runtimeRoot);
    const methods: string[] = [];
    const server = createServer((socket) => {
        const codec = new Codec(Channel.accept(socket), { local: "server" });
        codec.onEvent((event) => {
            methods.push(event.name);
            const payload: JsonValue = event.name === "instance.list"
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
                : event.name === "runtime.readLogs"
                  ? [
                        {
                            at: "2026-07-08T00:00:00.000Z",
                            message: "ready\n",
                            seq: 1,
                            stream: "stdout"
                        }
                    ]
                  : null;
            void codec.send({
                id: `reply-${event.id}`,
                replyTo: event.id,
                destination: event.destination,
                name: event.name,
                payload
            }).catch(() => undefined);
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

    const clients = createCliClients({ socketPath });
    const instances = await clients.instance.list();
    const logs = await clients.runtime.readLogs("demo-local", { limit: 1 });

    assert.equal(instances[0]?.name, "demo-local");
    assert.equal(instances[0]?.snapshot.status, "stopped");
    assert.equal(logs[0]?.message, "ready\n");
    assert.deepEqual(methods, ["instance.list", "runtime.readLogs"]);
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
