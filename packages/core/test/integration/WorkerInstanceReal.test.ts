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

const cliToolCallContext = { source: "cli" } as const;

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
        await instance.close();
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
    assert.deepEqual(
        replay.events.map((event) => event.type),
        [
            "instance.statusChanged",
            "instance.connectionChanged",
            "worker.rpcConnected",
            "worker.schemaRefreshed",
            "instance.started",
            "instance.statusChanged",
            "instance.connectionChanged",
            "instance.readyChanged"
        ]
    );
    assert.deepEqual(replay.events[0]?.data, {
        connectionState: "disconnected",
        daemonState: "starting",
        previousDaemonState: "stopped",
        previousStatus: "stopped",
        ready: false,
        status: "running"
    });
    assert.deepEqual(replay.events.at(-1)?.data, {
        connectionState: "connected",
        daemonState: "running",
        previousReady: false,
        ready: true,
        status: "ready"
    });

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
        const stdout = "x".repeat(240);

        await assert.rejects(instance.callTool("bash_run", { command: "pwd" }, cliToolCallContext), (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreInstanceNotReady);
            return true;
        });

        const started = await instance.start("/tmp/workspace");
        assert.equal(started.ready, true);

        const firstCall = instance.callTool("bash_run", { command: "pwd" }, cliToolCallContext);
        await harness.waitForMethod("bash_run");

        await assert.rejects(instance.callTool("bash_run", { command: "ls" }, cliToolCallContext), (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreInstanceBusy);
            return true;
        });

        harness.respond("bash_run", {
            exitCode: 0,
            stderr: "",
            stdout
        });

        const result = await firstCall;
        assert.equal(result.stdout, stdout);

        const invalidCall = instance.callTool("bash_run", { bad: true } as JsonValue, cliToolCallContext);
        await assert.rejects(invalidCall, (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreToolSchemaUnavailable);
            return true;
        });

        const records = await instance.readToolCalls();
        assert.deepEqual(records.map((record) => record.status), ["completed", "failed"]);
        assert.equal(records[0]?.source, "cli");
        assert.equal(records[0]?.inputSummary, "{\"command\":\"pwd\"}");
        assert.equal(records[0]?.stdoutBytes, 240);
        assert.equal(records[0]?.stderrBytes, 0);
        assert.equal(records[0]?.timedOut, false);
        assert.equal(records[1]?.error, errorCodes.coreToolSchemaUnavailable);
        assert.deepEqual(
            (await instance.readToolCalls({ after: records[0]?.callId, limit: 1, status: "failed", toolName: "bash_run" })).map(
                (record) => record.callId
            ),
            [records[1]?.callId]
        );

        const logs = await instance.readLogs();
        assert.equal(logs.length, 1);
        assert.equal(logs[0]?.stream, "stdout");
        assert.equal(logs[0]?.message, stdout);

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.deepEqual(
            replay.events.map((event) => event.type),
            [
                "instance.statusChanged",
                "instance.connectionChanged",
                "worker.rpcConnected",
                "worker.schemaRefreshed",
                "instance.started",
                "instance.statusChanged",
                "instance.connectionChanged",
                "instance.readyChanged",
                "toolCall.started",
                "log.appended",
                "toolCall.completed",
                "toolCall.started",
                "toolCall.failed"
            ]
        );
        assert.deepEqual(replay.events[8]?.data, {
            callId: replay.events[8]?.data?.callId,
            source: "cli",
            startedAt: replay.events[8]?.data?.startedAt,
            status: "started",
            toolName: "bash_run"
        });
        assert.deepEqual(replay.events[9]?.data, {
            bytes: 240,
            callId: replay.events[8]?.data?.callId,
            preview: stdout.slice(0, 160),
            source: "cli",
            stream: "stdout",
            tail: stdout.slice(-160),
            toolName: "bash_run"
        });
        assert.equal((replay.events[9]?.data as { preview?: string }).preview, stdout.slice(0, 160));
        assert.notEqual((replay.events[9]?.data as { preview?: string }).preview, stdout);
        assert.deepEqual(replay.events[10]?.data, {
            callId: replay.events[8]?.data?.callId,
            completedAt: replay.events[10]?.data?.completedAt,
            exitCode: 0,
            source: "cli",
            startedAt: replay.events[8]?.data?.startedAt,
            status: "completed",
            stderrBytes: 0,
            stdoutBytes: 240,
            toolName: "bash_run"
        });
        assert.deepEqual(replay.events[12]?.data, {
            callId: replay.events[12]?.data?.callId,
            completedAt: replay.events[12]?.data?.completedAt,
            errorCode: errorCodes.coreToolSchemaUnavailable,
            source: "cli",
            startedAt: replay.events[12]?.data?.startedAt,
            status: "failed",
            toolName: "bash_run"
        });

        await instance.stop();
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance refreshStatus updates snapshot from worker status without auto start", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-instance-refresh-"));
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("task-6-refresh"),
        transport: harness.transport
    });

    try {
        const stopped = await instance.refreshStatus();
        assert.equal(stopped.daemonState, "stopped");
        assert.equal(stopped.connectionState, "disconnected");
        assert.equal(harness.requestedMethods(), 0);

        harness.setStatus("running");
        const running = await instance.refreshStatus();
        assert.equal(running.daemonState, "running");
        assert.equal(running.connectionState, "connected");
        assert.equal(running.ready, true);
        assert.equal(instance.listTools()[0]?.name, "bash_run");

        harness.setStatus("stale");
        const stale = await instance.refreshStatus();
        assert.equal(stale.daemonState, "stale");
        assert.equal(stale.connectionState, "disconnected");
        assert.equal(stale.ready, false);

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.deepEqual(
            replay.events.map((event) => event.type),
            [
                "instance.statusChanged",
                "instance.connectionChanged",
                "worker.rpcConnected",
                "worker.schemaRefreshed",
                "instance.connectionChanged",
                "instance.readyChanged",
                "instance.statusChanged",
                "instance.connectionChanged",
                "instance.readyChanged"
            ]
        );
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance reconnectRpc refreshes schema after an rpc disconnect", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-instance-reconnect-"));
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("task-6-reconnect"),
        transport: harness.transport
    });

    try {
        await instance.start("/tmp/workspace");
        assert.deepEqual(instance.listTools()[0]?.inputSchema, toolSchemaFor("command"));

        harness.setTools([
            {
                description: "Run a shell command.",
                inputSchema: toolSchemaFor("cwd"),
                name: "bash_run"
            }
        ]);
        harness.disconnect();
        await harness.waitForMethodCount("tools.list", 2);

        assert.equal(instance.snapshot().connectionState, "connected");
        assert.deepEqual(instance.listTools()[0]?.inputSchema, toolSchemaFor("cwd"));

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.deepEqual(
            replay.events.map((event) => event.type),
            [
                "instance.statusChanged",
                "instance.connectionChanged",
                "worker.rpcConnected",
                "worker.schemaRefreshed",
                "instance.started",
                "instance.statusChanged",
                "instance.connectionChanged",
                "instance.readyChanged",
                "worker.rpcDisconnected",
                "instance.connectionChanged",
                "instance.readyChanged",
                "worker.rpcConnected",
                "worker.schemaRefreshed",
                "instance.connectionChanged",
                "instance.readyChanged"
            ]
        );
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

function createWorkerInstanceHarness(): {
    disconnect: () => void;
    setTools: (tools: Array<{ description: string; inputSchema: JsonValue; name: string }>) => void;
    transport: WorkerCommandTransport;
    requestedMethods: () => number;
    respond: (method: string, result: Record<string, JsonValue>) => void;
    setStatus: (status: "running" | "stale" | "stopped") => void;
    waitForMethod: (method: string) => Promise<void>;
    waitForMethodCount: (method: string, count: number) => Promise<void>;
} {
    const pending = new Map<string, string>();
    const requestMethods: string[] = [];
    const methodWaiters = new Map<string, Array<() => void>>();
    let commandStatus: "running" | "stale" | "stopped" = "stopped";
    let tools = [
        {
            description: "Run a shell command.",
            inputSchema: toolSchemaFor("command"),
            name: "bash_run"
        }
    ];
    let activeProcess:
        | {
              exitResolve?: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
              stdout: PassThrough;
              writer: FrameWriter;
          }
        | undefined;

    const transport: WorkerCommandTransport = {
        async runWorkerCommand(command): Promise<WorkerCommandResult> {
            if (command === "status") {
                return {
                    exitCode: 0,
                    stderr: "",
                    stdout: JSON.stringify({
                        instance: "task-6-harness",
                        ok: true,
                        pid: commandStatus === "stopped" ? null : 4321,
                        running: commandStatus === "running",
                        state: commandStatus,
                        workspace: commandStatus === "running" ? "/tmp/workspace" : null
                    })
                };
            }

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
            const stdout = new PassThrough();
            const stdin = new PassThrough();
            const stderr = new PassThrough();
            const reader = new FrameReader();
            const writer = new FrameWriter(stdout);
            let exitResolve: ((value: { code: number | null; signal: NodeJS.Signals | null }) => void) | undefined;

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
                        void writer.write(createLifecycleResponse(frame.method, frame.id, tools) as unknown as JsonValue);
                    }
                }
            });

            activeProcess = { stdout, writer };
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
                    if (activeProcess !== undefined) {
                        activeProcess.exitResolve = resolve;
                    }
                })
            };
        },
        async installWorker(): Promise<void> {}
    };

    return {
        disconnect() {
            activeProcess?.stdout.end();
            activeProcess?.exitResolve?.({ code: 1, signal: null });
        },
        setTools(nextTools) {
            tools = nextTools;
        },
        transport,
        requestedMethods() {
            return requestMethods.length;
        },
        respond(method, result) {
            const requestId = pending.get(method);

            if (requestId === undefined) {
                throw new Error(`No pending request for ${method}.`);
            }

            pending.delete(method);
            void activeProcess?.writer.write({
                id: requestId,
                ok: true,
                result,
                type: "response"
            } as unknown as JsonValue);
        },
        setStatus(status) {
            commandStatus = status;
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
        },
        waitForMethodCount(method, count) {
            if (requestMethods.filter((value) => value === method).length >= count) {
                return Promise.resolve();
            }

            return new Promise<void>((resolve) => {
                const poll = () => {
                    if (requestMethods.filter((value) => value === method).length >= count) {
                        resolve();
                        return;
                    }

                    setTimeout(poll, 10);
                };

                poll();
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

function createLifecycleResponse(
    method: string,
    id: string,
    tools: Array<{ description: string; inputSchema: JsonValue; name: string }>
): WorkerRpcResponseEnvelope {
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
            tools
        },
        type: "response"
    };
}

function toolSchemaFor(field: string): JsonValue {
    return {
        properties: {
            [field]: { type: "string" }
        },
        required: [field],
        type: "object"
    };
}
