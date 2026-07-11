import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    const bashRun = instance.listTools().find((tool) => tool.name === "bash_run");
    assert.notEqual(bashRun, undefined);
    assert.notEqual(bashRun?.inputSchema, undefined);

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

test("WorkerInstance rejects not-ready and schedules concurrent tool calls while persisting history", async () => {
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
        const secondCall = instance.callTool("bash_run", { command: "ls" }, cliToolCallContext);
        await harness.waitForMethodCount("bash_run", 2);
        const runningRecords = await instance.readToolCalls({ status: "running" });
        assert.deepEqual(
            runningRecords.map((record) => ({
                status: record.status,
                toolName: record.toolName
            })),
            [
                { status: "running", toolName: "bash_run" },
                { status: "running", toolName: "bash_run" }
            ]
        );

        harness.respond("bash_run", {
            exitCode: 0,
            stderr: "",
            stdout
        });

        const result = await firstCall;
        assert.equal(result.stdout, stdout);

        harness.respond("bash_run", {
            exitCode: 0,
            stderr: "",
            stdout: "ls output\n"
        });

        const secondResult = await secondCall;
        assert.equal(secondResult.stdout, "ls output\n");

        const invalidCall = instance.callTool("bash_run", { bad: true } as JsonValue, cliToolCallContext);
        await assert.rejects(invalidCall, (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreToolSchemaUnavailable);
            return true;
        });

        const records = await instance.readToolCalls();
        assert.deepEqual(records.map((record) => record.status), ["completed", "completed", "failed"]);
        assert.equal(records[0]?.source, "cli");
        assert.equal(records[0]?.inputSummary, "{\"command\":\"pwd\"}");
        assert.equal(records[0]?.stdoutBytes, 240);
        assert.equal(records[0]?.stderrBytes, 0);
        assert.equal(records[0]?.termination, undefined);
        assert.equal(records[2]?.error, errorCodes.coreToolSchemaUnavailable);
        assert.deepEqual(
            (await instance.readToolCalls({ after: records[1]?.callId, limit: 1, status: "failed", toolName: "bash_run" })).map(
                (record) => record.callId
            ),
            [records[2]?.callId]
        );

        const logs = await instance.readLogs();
        assert.equal(logs.length, 2);
        assert.equal(logs[0]?.stream, "stdout");
        assert.equal(logs[0]?.message, stdout);
        assert.equal(logs[1]?.stream, "stdout");
        assert.equal(logs[1]?.message, "ls output\n");

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.deepEqual(
            replay.events.slice(0, 8).map((event) => event.type),
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

        const eventTypesForCall = (callId: string | undefined) =>
            replay.events.filter((event) => event.data?.callId === callId).map((event) => event.type);

        assert.deepEqual(eventTypesForCall(records[0]?.callId), [
            "toolCall.queued",
            "toolCall.running",
            "log.appended",
            "toolCall.completed"
        ]);
        assert.deepEqual(eventTypesForCall(records[1]?.callId), [
            "toolCall.queued",
            "toolCall.running",
            "log.appended",
            "toolCall.completed"
        ]);
        assert.deepEqual(eventTypesForCall(records[2]?.callId), [
            "toolCall.queued",
            "toolCall.running",
            "toolCall.failed"
        ]);

        const firstQueued = replay.events.find(
            (event) => event.type === "toolCall.queued" && event.data?.callId === records[0]?.callId
        );
        const firstRunning = replay.events.find(
            (event) => event.type === "toolCall.running" && event.data?.callId === records[0]?.callId
        );
        const failedEvent = replay.events.find(
            (event) => event.type === "toolCall.failed" && event.data?.callId === records[2]?.callId
        );

        assert.deepEqual(firstQueued?.data, {
            callId: records[0]?.callId,
            queuedAt: firstQueued?.data.queuedAt,
            source: "cli",
            startedAt: firstQueued?.data.startedAt,
            status: "queued",
            toolName: "bash_run"
        });
        assert.deepEqual(firstRunning?.data, {
            callId: records[0]?.callId,
            source: "cli",
            startedAt: firstQueued?.data.startedAt,
            status: "running",
            toolName: "bash_run"
        });
        assert.deepEqual(failedEvent?.data, {
            callId: records[2]?.callId,
            completedAt: failedEvent?.data.completedAt,
            errorCode: errorCodes.coreToolSchemaUnavailable,
            source: "cli",
            startedAt: failedEvent?.data.startedAt,
            status: "failed",
            toolName: "bash_run"
        });

        await instance.stop();
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance waits for approval before invoking tools and persists approval records", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-instance-approval-"));
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        homeDirectory,
        name: asInstanceName("task-6-approval"),
        transport: harness.transport
    });

    try {
        await instance.start("/tmp/workspace");
        const beforeInvokeCount = harness.requestedMethods();
        const callPromise = instance.callTool("bash_run", { command: "pwd" }, cliToolCallContext);

        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(harness.requestedMethods(), beforeInvokeCount);

        const approvals = await instance.listApprovals();
        assert.equal(approvals.length, 1);
        assert.equal(approvals[0]?.status, "pending");
        assert.equal(approvals[0]?.source, "cli");

        const approvalId = approvals[0]?.approvalId ?? "";
        assert.notEqual(approvalId, "");
        assert.equal((await instance.getApproval(approvalId)).status, "pending");
        assert.deepEqual(
            (await instance.readToolCalls({ status: "pendingApproval" })).map((record) => ({
                approvalId: record.approvalId,
                status: record.status,
                toolName: record.toolName
            })),
            [
                {
                    approvalId,
                    status: "pendingApproval",
                    toolName: "bash_run"
                }
            ]
        );

        const pendingReplay = instance.subscribe(1);
        assert.equal(pendingReplay.kind, "events");
        assert.equal(pendingReplay.events.some((event) => event.type === "approval.requested"), true);
        assert.equal(pendingReplay.events.some((event) => event.type === "toolCall.pendingApproval"), true);
        assert.equal(pendingReplay.events.some((event) => event.type === "toolCall.running"), false);

        await instance.decideApproval(approvalId, {
            decidedBy: "cli",
            decision: "approve",
            reason: "approved in test"
        });
        await harness.waitForMethod("bash_run");
        harness.respond("bash_run", {
            exitCode: 0,
            stderr: "",
            stdout: "/tmp/workspace\n"
        });

        const result = await callPromise;
        assert.equal(result.stdout, "/tmp/workspace\n");

        const records = await instance.readToolCalls();
        assert.equal(records[0]?.status, "completed");
        assert.equal(records[0]?.decision, "approved");
        assert.equal(records[0]?.approvalId, approvalId);

        const approved = await instance.getApproval(approvalId);
        assert.equal(approved.status, "approved");
        assert.equal(approved.decision?.decision, "approve");
        assert.equal(approved.decision?.decidedBy, "cli");

        const approvalsFile = await readFile(join(homeDirectory, ".devshell", "task-6-approval", "control-worker", "approvals.jsonl"), "utf8");
        assert.match(approvalsFile, new RegExp(approvalId, "u"));

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        const eventTypes = replay.events.map((event) => event.type);
        assert.equal(eventTypes.includes("approval.requested"), true);
        assert.equal(eventTypes.includes("approval.approved"), true);
        assert.equal(eventTypes.includes("toolCall.pendingApproval"), true);
        assert.equal(eventTypes.includes("toolCall.running"), true);
        assert.equal(eventTypes.includes("toolCall.completed"), true);
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance denies and expires approval-gated calls without invoking tools", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-instance-approval-fail-"));
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        approvalTimeout: { ms: 40 },
        homeDirectory,
        name: asInstanceName("task-6-approval-fail"),
        transport: harness.transport
    });

    try {
        await instance.start("/tmp/workspace");

        const beforeDeniedInvokeCount = harness.requestedMethods();
        const deniedPromise = instance.callTool("bash_run", { command: "pwd" }, { requestId: "req-deny", source: "mcp" });
        await new Promise((resolve) => setTimeout(resolve, 25));
        const deniedApprovalId = (await instance.listApprovals())[0]?.approvalId ?? "";
        await instance.decideApproval(deniedApprovalId, {
            decidedBy: "cli",
            decision: "deny",
            reason: "denied in test"
        });
        await assert.rejects(deniedPromise, (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreApprovalDenied);
            return true;
        });
        assert.equal(harness.requestedMethods(), beforeDeniedInvokeCount);

        const afterDenied = await instance.readToolCalls();
        assert.equal(afterDenied[0]?.status, "denied");
        assert.equal(afterDenied[0]?.source, "mcp");
        assert.equal(afterDenied[0]?.decision, "denied");

        const beforeExpiredInvokeCount = harness.requestedMethods();
        const expiredPromise = instance.callTool("bash_run", { command: "pwd" }, cliToolCallContext);
        await assert.rejects(expiredPromise, (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreApprovalExpired);
            return true;
        });
        assert.equal(harness.requestedMethods(), beforeExpiredInvokeCount);

        const records = await instance.readToolCalls();
        assert.deepEqual(records.map((record) => record.status), ["denied", "expired"]);
        assert.deepEqual(records.map((record) => record.decision), ["denied", "expired"]);

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        const eventTypes = replay.events.map((event) => event.type);
        assert.equal(eventTypes.includes("approval.denied"), true);
        assert.equal(eventTypes.includes("approval.expired"), true);
        assert.equal(eventTypes.includes("toolCall.denied"), true);
        assert.equal(eventTypes.includes("toolCall.expired"), true);
        assert.equal(eventTypes.includes("toolCall.running"), false);
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
                access: "execute",
                description: "Run a shell command.",
                group: "bash",
                inputSchema: toolSchemaFor("cwd"),
                name: "bash_run",
                outputSchema: { type: "object" }
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
    setTools: (tools: Array<{ access: "execute"; description: string; group: string; inputSchema: JsonValue; name: string; outputSchema: JsonValue }>) => void;
    transport: WorkerCommandTransport;
    requestedMethods: () => number;
    respond: (method: string, result: Record<string, JsonValue>) => void;
    setStatus: (status: "running" | "stale" | "stopped") => void;
    waitForMethod: (method: string) => Promise<void>;
    waitForMethodCount: (method: string, count: number) => Promise<void>;
} {
    const pending = new Map<string, string[]>();
    const requestMethods: string[] = [];
    const methodWaiters = new Map<string, Array<() => void>>();
    let commandStatus: "running" | "stale" | "stopped" = "stopped";
    let tools = [
        {
            access: "execute" as const,
            description: "Run a shell command.",
            group: "bash",
            inputSchema: toolSchemaFor("command"),
            name: "bash_run",
            outputSchema: { type: "object" }
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

                    const pendingIds = pending.get(frame.method) ?? [];
                    pendingIds.push(frame.id);
                    pending.set(frame.method, pendingIds);
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
            const requestIds = pending.get(method);
            const requestId = requestIds?.shift();

            if (requestId === undefined) {
                throw new Error(`No pending request for ${method}.`);
            }

            if (requestIds.length === 0) {
                pending.delete(method);
            }

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
    tools: Array<{ access: "execute"; description: string; inputSchema: JsonValue; name: string; outputSchema: JsonValue }>
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
