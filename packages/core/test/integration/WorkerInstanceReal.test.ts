import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    FrameReader,
    FrameWriter,
    asInstanceName,
    asWorkspacePath,
    errorCodes,
    type JsonValue
} from "@portable-devshell/shared";
import {
    LocalWorkerTransport,
    WorkerBinary,
    WorkerInstanceFactory,
    type WorkerCommandResult,
    type WorkerCommandTransport,
    type WorkerRpcResponseEnvelope
} from "@portable-devshell/core";

test("WorkerInstance completes lifecycle against frozen devshell-worker", async (t) => {
    const workspacePath = await mkdtemp(join(tmpdir(), "portable-devshell-instance-"));
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-instance-home-"));
    const instanceName = asInstanceName(`task-6-${process.pid}`);
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const factory = new WorkerInstanceFactory();
    const instance = factory.create({
        defaultWorkspace: asWorkspacePath(workspacePath),
        env: { ...process.env, HOME: homeDirectory },
        homeDirectory,
        name: instanceName,
        transport: new LocalWorkerTransport({
            workerBinary: new WorkerBinary(resolve(repoRoot, "target/debug/devshell-worker")),
            spawnFunction: nodeSpawn
        })
    });

    t.after(async () => {
        instance.close();
        await instance.stop().catch(() => undefined);
        await rm(workspacePath, { force: true, recursive: true });
        await rm(homeDirectory, { force: true, recursive: true });
    });

    const started = await instance.start();

    assert.equal(started.daemonState, "running");
    assert.equal(started.connectionState, "connected");
    assert.equal(started.ready, true);
    assert.equal(instance.handshake?.instance, instanceName);
    assert.equal(instance.handshake?.workspace, workspacePath);
    assert.equal(instance.listTools()[0]?.name, "bash_run");
    assert.notEqual(instance.listTools()[0]?.inputSchema, undefined);

    const replay = instance.subscribe(1);
    assert.equal(replay.kind, "events");
    assert.equal(replay.events[0]?.type, "instance.started");

    const stopped = await instance.stop();
    assert.equal(stopped.daemonState, "stopped");
    assert.equal(stopped.connectionState, "disconnected");
    assert.equal(stopped.ready, false);
});

test("WorkerInstance rejects not-ready and concurrent tool calls while persisting history", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-instance-harness-"));
    const harness = createWorkerInstanceHarness();
    const instanceName = asInstanceName("task-6-harness");
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: instanceName,
        transport: harness.transport
    });

    try {
        await assert.rejects(instance.callTool("bash_run", { command: "pwd" }), (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreInstanceNotReady);
            return true;
        });

        const started = await instance.start("/tmp/workspace");
        assert.equal(started.ready, true);

        const firstCall = instance.callTool("bash_run", { command: "pwd" });
        await harness.waitForMethod("bash_run");

        await assert.rejects(instance.callTool("bash_run", { command: "ls" }), (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreInstanceBusy);
            return true;
        });

        harness.respond("bash_run", {
            exitCode: 0,
            stderr: "",
            stdout: "/tmp/workspace\n"
        });

        const result = await firstCall;
        assert.equal(result.stdout, "/tmp/workspace\n");

        const invalidCall = instance.callTool("bash_run", { bad: true } as JsonValue);
        await assert.rejects(invalidCall, (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.toolSchemaInvalid);
            return true;
        });

        const records = await instance.readToolCalls();
        assert.deepEqual(records.map((record) => record.status), ["started", "completed", "started", "failed"]);
        assert.equal(records[3]?.errorCode, errorCodes.toolSchemaInvalid);

        const logs = await instance.readLogs();
        assert.equal(logs.length, 1);
        assert.equal(logs[0]?.stream, "stdout");
        assert.equal(logs[0]?.message, "/tmp/workspace\n");

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.deepEqual(
            replay.events.map((event) => event.type),
            ["instance.started", "instance.toolCalled", "instance.toolCalled"]
        );

        await instance.stop();
    } finally {
        instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

function createWorkerInstanceHarness(): {
    transport: WorkerCommandTransport;
    respond: (method: string, result: Record<string, JsonValue>) => void;
    waitForMethod: (method: string) => Promise<void>;
} {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const reader = new FrameReader();
    const writer = new FrameWriter(stdout);
    const pending = new Map<string, string>();
    const requestMethods: string[] = [];
    const methodWaiters = new Map<string, Array<() => void>>();
    let exitResolve: ((value: { code: number | null; signal: NodeJS.Signals | null }) => void) | undefined;

    const transport: WorkerCommandTransport = {
        async runWorkerCommand(command): Promise<WorkerCommandResult> {
            return {
                exitCode: 0,
                stderr: "",
                stdout:
                    command === "start"
                        ? JSON.stringify({ running: true, workspace: "/tmp/workspace" })
                        : JSON.stringify({ running: false })
            };
        },
        async spawnWorkerRpc() {
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

            pending.set(frame.method, frame.id);
            requestMethods.push(frame.method);
            methodWaiters.get(frame.method)?.splice(0).forEach((resolve) => resolve());

            if (frame.method === "worker.ping" || frame.method === "worker.handshake" || frame.method === "tools.list") {
                void writer.write(createLifecycleResponse(frame.method, frame.id) as unknown as JsonValue);
            }
        }
    });

    return {
        transport,
        respond(method, result) {
            const requestId = pending.get(method);

            if (requestId === undefined) {
                throw new Error(`No pending request for ${method}.`);
            }

            pending.delete(method);
            void writer.write({
                id: requestId,
                ok: true,
                result,
                type: "response"
            } as unknown as JsonValue);
        },
        waitForMethod(method) {
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

function createLifecycleResponse(method: string, id: string): WorkerRpcResponseEnvelope {
    if (method === "worker.ping") {
        return {
            id,
            ok: true,
            result: { pong: true },
            type: "response"
        };
    }

    if (method === "worker.handshake") {
        return {
            id,
            ok: true,
            result: {
                capabilities: { cancel: false, streaming: false, tools: true },
                instance: "task-6-harness",
                platform: { arch: "x64", os: "linux" },
                protocolVersion: 1,
                workerVersion: "0.1.0",
                workspace: "/tmp/workspace"
            },
            type: "response"
        };
    }

    return {
        id,
        ok: true,
        result: {
            tools: [
                {
                    description: "Run a shell command.",
                    inputSchema: {
                        properties: {
                            command: { type: "string" }
                        },
                        required: ["command"],
                        type: "object"
                    },
                    name: "bash_run"
                }
            ]
        },
        type: "response"
    };
}
