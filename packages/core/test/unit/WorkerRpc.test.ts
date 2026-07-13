import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FrameReader, FrameWriter, type JsonValue } from "@portable-devshell/shared";
import {
    LocalWorkerTransport,
    WorkerBinary,
    WorkerProtocolClient,
    WorkerRpcBridge,
    WorkerRpcClient,
    WorkerRpcError,
    workerRpcDisconnectedErrorCode,
    type WorkerCommandResult,
    type WorkerCommandTransport,
    type WorkerRpcResponseEnvelope
} from "@portable-devshell/core";

test("WorkerRpcBridge reuses one spawned rpc process across multiple calls", async () => {
    const harness = createRpcHarness();
    const bridge = new WorkerRpcBridge({
        transport: harness.transport,
        rpcOptions: { instanceName: "task-4-bridge" }
    });
    const rpcClient = new WorkerRpcClient(bridge);
    const protocolClient = new WorkerProtocolClient(rpcClient);

    const ping = await protocolClient.ping();
    const handshake = await protocolClient.handshake({
        minProtocolVersion: 2,
        maxProtocolVersion: 2,
        clientName: "portable-devshell",
        clientVersion: "0.1.0"
    });
    const tools = await protocolClient.listTools();

    assert.equal(ping.pong, true);
    assert.equal(handshake.protocolVersion, 2);
    assert.equal("tools" in handshake, false);
    assert.equal(tools.tools[0]?.name, "bash_run");
    assert.equal(harness.spawnCount, 1);
    assert.deepEqual(harness.requestMethods, ["worker.ping", "worker.handshake", "tools.list"]);
    bridge.close();
});

test("WorkerProtocolClient routes artifact payload and receive lifecycle through internal RPC methods", async () => {
    const harness = createRpcHarness();
    const bridge = new WorkerRpcBridge({
        transport: harness.transport,
        rpcOptions: { instanceName: "artifact-rpc" }
    });
    const client = new WorkerProtocolClient(new WorkerRpcClient(bridge));

    const opened = await client.openArtifactPayload({
        expiresAtMs: Date.now() + 60_000,
        path: "./result.bin"
    });
    const chunk = await client.readArtifactPayload({
        maxBytes: 1024,
        offsetBytes: 0,
        payloadId: opened.payloadId
    });
    const receive = await client.beginArtifactReceive({
        descriptor: opened.descriptor,
        overwrite: false,
        targetPath: "./copy.bin"
    });
    await client.writeArtifactReceive({
        content: chunk.content,
        offsetBytes: 0,
        receiveId: receive.receiveId
    });
    await client.finishArtifactReceive(receive.receiveId);
    await client.abortArtifactReceive(receive.receiveId);
    await client.closeArtifactPayload(opened.payloadId);

    assert.deepEqual(harness.requestMethods, [
        "artifact.payload.open",
        "artifact.payload.read",
        "artifact.receive.begin",
        "artifact.receive.write",
        "artifact.receive.finish",
        "artifact.receive.abort",
        "artifact.payload.close"
    ]);
    bridge.close();
});

test("WorkerRpcBridge rejects pending calls when the rpc bridge disconnects", async () => {
    const harness = createRpcHarness({
        slowMethods: new Set(["tools.list"])
    });
    const bridge = new WorkerRpcBridge({
        transport: harness.transport,
        rpcOptions: { instanceName: "task-4-disconnect" }
    });
    const disconnects: string[] = [];
    bridge.onDisconnect((error) => {
        disconnects.push(error.code);
    });
    const rpcClient = new WorkerRpcClient(bridge);
    const protocolClient = new WorkerProtocolClient(rpcClient);

    const pendingCall = protocolClient.listTools();
    await harness.waitForMethod("tools.list");
    harness.disconnect();

    await assert.rejects(pendingCall, (error: unknown) => {
        assert.ok(error instanceof WorkerRpcError);
        assert.equal(error.code, workerRpcDisconnectedErrorCode);
        return true;
    });
    assert.equal(harness.spawnCount, 1);
    assert.deepEqual(disconnects, [workerRpcDisconnectedErrorCode]);
});

test("WorkerRpcBridge surfaces spawn failures as structured rpc spawn errors", async () => {
    const bridge = new WorkerRpcBridge({
        transport: {
            async installWorker() {},
            async runWorkerCommand(): Promise<WorkerCommandResult> {
                throw new Error("unused");
            },
            async spawnWorkerRpc() {
                throw new Error("spawn denied");
            }
        },
        rpcOptions: { instanceName: "task-4-spawn" }
    });

    await assert.rejects(bridge.connect(), (error: unknown) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.equal((error as { code?: string }).code, "core.workerRpcSpawnFailed");
        assert.equal((error as { details?: Record<string, unknown> }).details?.instance, "task-4-spawn");
        return true;
    });
});

test("WorkerProtocolClient performs ping, handshake, and tools.list against frozen devshell-worker", async (t) => {
    const workspacePath = await mkdtemp(join(tmpdir(), "portable-devshell-core-rpc-"));
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-core-rpc-home-"));
    const instanceName = `task-4-${process.pid}`;
    const env = { ...process.env, HOME: homeDirectory };
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const transport = new LocalWorkerTransport({
        workerBinary: new WorkerBinary(resolve(repoRoot, "target/debug/devshell-worker")),
        spawnFunction: nodeSpawn
    });
    const commandResult = await transport.runWorkerCommand("start", { env, instanceName, workspacePath });

    assert.equal(commandResult.exitCode, 0);

    const bridge = new WorkerRpcBridge({
        transport,
        rpcOptions: { env, instanceName }
    });

    t.after(async () => {
        bridge.close();
        await transport.runWorkerCommand("stop", { env, instanceName });
        await rm(homeDirectory, { recursive: true, force: true });
        await rm(workspacePath, { recursive: true, force: true });
    });
    const protocolClient = new WorkerProtocolClient(new WorkerRpcClient(bridge));

    const ping = await protocolClient.ping();
    const handshake = await protocolClient.handshake({
        minProtocolVersion: 2,
        maxProtocolVersion: 2,
        clientName: "portable-devshell",
        clientVersion: "0.1.0"
    });
    const tools = await protocolClient.listTools();

    assert.equal(ping.pong, true);
    assert.equal(handshake.instance, instanceName);
    assert.equal(handshake.workspace, workspacePath);
    assert.equal(handshake.protocolVersion, 2);
    assert.equal("tools" in handshake, false);
    const bashRun = tools.tools.find((tool) => tool.name === "bash_run");
    assert.notEqual(bashRun, undefined);
    assert.notEqual(bashRun?.inputSchema, undefined);
});

function createRpcHarness(options?: { slowMethods?: Set<string> }): {
    transport: WorkerCommandTransport;
    spawnCount: number;
    requestMethods: string[];
    disconnect: () => void;
    waitForMethod: (method: string) => Promise<void>;
} {
    const requestMethods: string[] = [];
    const slowMethods = options?.slowMethods ?? new Set<string>();
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const reader = new FrameReader();
    const writer = new FrameWriter(stdout);
    let spawnCount = 0;
    let exitResolve: ((value: { code: number | null; signal: NodeJS.Signals | null }) => void) | undefined;
    const methodWaiters = new Map<string, Array<() => void>>();
    const transport: WorkerCommandTransport = {
        async runWorkerCommand(): Promise<WorkerCommandResult> {
            throw new Error("runWorkerCommand should not be called in RPC harness tests.");
        },
        async spawnWorkerRpc() {
            spawnCount += 1;
            return {
                stdin,
                stdout,
                stderr,
                kill() {
                    stdout.end();
                    exitResolve?.({ code: null, signal: "SIGTERM" });
                    return true;
                },
                exit: new Promise((resolve) => {
                    exitResolve = resolve;
                })
            };
        },
        async installWorker(): Promise<void> {}
    };

    stdin.on("data", (chunk: Uint8Array) => {
        const frames = reader.push(chunk);

        for (const frame of frames) {
            if (!isRequestFrame(frame)) {
                continue;
            }

            requestMethods.push(frame.method);
            methodWaiters.get(frame.method)?.splice(0).forEach((resolve) => resolve());

            if (slowMethods.has(frame.method)) {
                continue;
            }

            void writer.write(createResponse(frame.method, frame.id) as unknown as JsonValue);
        }
    });

    return {
        transport,
        get spawnCount() {
            return spawnCount;
        },
        requestMethods,
        disconnect() {
            stdout.end();
            exitResolve?.({ code: 1, signal: null });
        },
        waitForMethod(method: string) {
            if (requestMethods.includes(method)) {
                return Promise.resolve();
            }

            return new Promise<void>((resolve) => {
                const waiters = methodWaiters.get(method) ?? [];
                waiters.push(resolve);
                methodWaiters.set(method, waiters);
            });
        }
    };
}

function isRequestFrame(value: unknown): value is { id: string; method: string } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return candidate.type === "request" && typeof candidate.id === "string" && typeof candidate.method === "string";
}

function createResponse(method: string, id: string): WorkerRpcResponseEnvelope {
    if (method === "worker.ping") {
        return {
            type: "response",
            id,
            ok: true,
            result: { pong: true }
        };
    }

    if (method === "worker.handshake") {
        return {
            type: "response",
            id,
            ok: true,
            result: {
                instance: "task-4-bridge",
                workspace: "/tmp/workspace",
                workerVersion: "0.1.0",
                protocolVersion: 2,
                platform: { os: "linux", arch: "x64" },
                capabilities: { tools: true, streaming: false, cancel: false }
            }
        };
    }

    if (method === "artifact.payload.open") {
        return {
            type: "response",
            id,
            ok: true,
            result: {
                payloadId: "payload-1",
                expiresAtMs: Date.now() + 60_000,
                descriptor: {
                    type: "file",
                    name: "result.bin",
                    mediaType: "application/octet-stream",
                    payloadBytes: 3,
                    payloadBlake3: "a".repeat(64)
                }
            }
        };
    }

    if (method === "artifact.payload.read") {
        return {
            type: "response",
            id,
            ok: true,
            result: {
                payloadId: "payload-1",
                offsetBytes: 0,
                returnedBytes: 3,
                totalBytes: 3,
                content: "YWJj",
                encoding: "base64",
                eof: true
            }
        };
    }

    if (method === "artifact.receive.begin") {
        return {
            type: "response",
            id,
            ok: true,
            result: { receiveId: "receive-1", nextOffsetBytes: 0 }
        };
    }

    if (method === "artifact.receive.write") {
        return {
            type: "response",
            id,
            ok: true,
            result: { receiveId: "receive-1", receivedBytes: 3, nextOffsetBytes: 3 }
        };
    }

    if (method === "artifact.receive.finish") {
        return {
            type: "response",
            id,
            ok: true,
            result: { receiveId: "receive-1", targetPath: "/tmp/copy.bin", bytes: 3, blake3: "a".repeat(64) }
        };
    }

    if (method === "artifact.receive.abort") {
        return { type: "response", id, ok: true, result: { receiveId: "receive-1", aborted: true } };
    }

    if (method === "artifact.payload.close") {
        return { type: "response", id, ok: true, result: { payloadId: "payload-1", closed: true } };
    }

    return {
        type: "response",
        id,
        ok: true,
        result: {
            tools: [
                {
                    requiredCapabilities: ["execute"],
                    group: "bash",
                    name: "bash_run",
                    description: "Run a shell command.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            command: { type: "string" }
                        },
                        required: ["command"]
                    },
                    outputSchema: { type: "object" }
                }
            ]
        }
    };
}
