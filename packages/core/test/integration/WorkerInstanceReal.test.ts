import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
    asInstanceName,
    errorCodes,
    toolCallOutput,
    type JsonValue
} from "@portable-devshell/shared";
import { encodeFrame, FrameBuffer } from "@portable-devshell/shared/transport/frame";
import {
    WorkerTransportDriverLocal,
    WorkerBinary,
    WorkerInstanceFactory,
    WORKER_PROTOCOL_VERSION,
    decodeWorkerRpcMessage,
    encodeWorkerRpcMessage,
    type WorkerCommandResult,
    type WorkerCommandTransport,
    type WorkerRpcResponseEnvelope
} from "@portable-devshell/core/testing";
import { realWorkerTestOptions, resolveTestWorkerBinary } from "../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const workerBinaryPath = resolveTestWorkerBinary();

const cliToolCallContext = { source: "cli" } as const;

test("WorkerInstance completes lifecycle against frozen devshell-worker", realWorkerTestOptions(workerBinaryPath), async (t) => {
    const workspacePath = await createTestTempDirectory("instance");
    const homeDirectory = await createTestTempDirectory("instance-home");
    const runtimeDirectory = await createTestTempDirectory("instance-runtime");
    const instanceName = asInstanceName(`task-6-${process.pid}`);
    const factory = new WorkerInstanceFactory();
    const instance = factory.create({
        env: { ...process.env, HOME: homeDirectory, XDG_RUNTIME_DIR: runtimeDirectory },
        homeDirectory,
        name: instanceName,
        transport: new WorkerTransportDriverLocal({
            workerBinary: new WorkerBinary(workerBinaryPath!),
            spawnFunction: nodeSpawn
        })
    });

    t.after(async () => {
        await instance.stop();
        await instance.close();
        await rm(workspacePath, { force: true, recursive: true });
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(runtimeDirectory, { force: true, recursive: true });
    });

    const started = await instance.start();

    assert.equal(started.daemonState, "running");
    assert.equal(started.connectionState, "connected");
    assert.equal(started.ready, true);
    assert.equal(instance.handshake?.instance, instanceName);
    assert.equal(instance.handshake?.homeDirectory, homeDirectory);
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

test("WorkerInstance serializes start and stop lifecycle operations", async () => {
    const homeDirectory = await createTestTempDirectory("instance-serialized");
    const harness = createWorkerInstanceHarness();
    const commands: string[] = [];
    let startCompleted = false;
    let stopOverlappedStart = false;
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
    });
    const transport: WorkerCommandTransport = {
        ...harness.transport,
        async runWorkerCommand(command, options) {
            commands.push(command);
            if (command === "stop" && !startCompleted) {
                stopOverlappedStart = true;
            }
            if (command === "start") {
                await startGate;
                startCompleted = true;
            }
            return await harness.transport.runWorkerCommand(command, options);
        }
    };
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("serialized-lifecycle"),
        transport
    });

    try {
        const starting = instance.start();
        await waitFor(() => commands.includes("start"));
        const stopping = instance.stop();
        await new Promise<void>((resolve) => setImmediate(resolve));

        releaseStart();
        await starting;
        await stopping;
        assert.deepEqual(commands, ["start", "stop"]);
        assert.equal(stopOverlappedStart, false);
    } finally {
        releaseStart();
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance audits control-owned tool calls while the worker is stopped", async () => {
    const homeDirectory = await createTestTempDirectory("control-audit");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("control-audit"),
        transport: harness.transport
    });

    try {
        const context = {
            ctxId: "ctx-control-audit",
            requestId: "request-control-audit",
            source: "mcp"
        } as const;
        const completed = await instance.auditToolCall(
            "todo_read",
            {},
            context,
            async () => ({ revision: 7 })
        );
        assert.deepEqual(completed, { revision: 7 });

        await assert.rejects(
            instance.auditToolCall("instance_status", { instance: "missing" }, context, async () => {
                const error = new Error("missing instance");
                Object.assign(error, { code: errorCodes.instanceMissing, retryable: false });
                throw error;
            }),
            (error: unknown) => {
                assert.equal((error as { code?: string }).code, errorCodes.instanceMissing);
                return true;
            }
        );

        await assert.rejects(
            instance.auditToolCall("artifact_transfer", { operation: "status", transferId: "transfer-1" }, context, async () => {
                const error = new Error("client cancelled");
                Object.assign(error, { code: errorCodes.coreToolCallCancelled, retryable: true });
                throw error;
            }),
            (error: unknown) => {
                assert.equal((error as { code?: string }).code, errorCodes.coreToolCallCancelled);
                return true;
            }
        );

        const records = await instance.readToolCalls();
        assert.deepEqual(
            records.map((record) => ({
                ctxId: record.ctxId,
                error: record.error,
                input: record.input,
                output: record.output,
                requestId: record.requestId,
                source: record.source,
                status: record.status,
                toolName: record.toolName
            })),
            [
                {
                    ctxId: "ctx-control-audit",
                    error: undefined,
                    input: {},
                    output: { revision: 7 },
                    requestId: "request-control-audit",
                    source: "mcp",
                    status: "completed",
                    toolName: "todo_read"
                },
                {
                    ctxId: "ctx-control-audit",
                    error: errorCodes.instanceMissing,
                    input: { instance: "missing" },
                    output: undefined,
                    requestId: "request-control-audit",
                    source: "mcp",
                    status: "failed",
                    toolName: "instance_status"
                },
                {
                    ctxId: "ctx-control-audit",
                    error: errorCodes.coreToolCallCancelled,
                    input: { operation: "status", transferId: "transfer-1" },
                    output: undefined,
                    requestId: "request-control-audit",
                    source: "mcp",
                    status: "cancelled",
                    toolName: "artifact_transfer"
                }
            ]
        );

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        const eventTypesForCall = (callId: string | undefined) =>
            replay.events.filter((event) => jsonRecord(event.data)?.callId === callId).map((event) => event.type);
        assert.deepEqual(eventTypesForCall(records[0]?.callId), ["toolCall.running", "toolCall.completed"]);
        assert.deepEqual(eventTypesForCall(records[1]?.callId), ["toolCall.running", "toolCall.failed"]);
        assert.deepEqual(eventTypesForCall(records[2]?.callId), ["toolCall.running", "toolCall.cancelled"]);
        const completedEvent = replay.events.find(
            (event) => event.type === "toolCall.completed" && jsonRecord(event.data)?.callId === records[0]?.callId
        );
        assert.equal(jsonRecord(completedEvent?.data)?.output, undefined);
        assert.deepEqual(records[0]?.output, { revision: 7 });
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance rejects not-ready and records concurrent tool-call history", async () => {
    const homeDirectory = await createTestTempDirectory("instance-harness");
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

        const started = await instance.start();
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
        assert.equal(jsonRecord(result)?.stdout, stdout);

        harness.respond("bash_run", {
            exitCode: 0,
            stderr: "",
            stdout: "ls output\n"
        });

        const secondResult = await secondCall;
        assert.equal(jsonRecord(secondResult)?.stdout, "ls output\n");

        const invalidCall = instance.callTool("bash_run", { bad: true } as JsonValue, cliToolCallContext);
        await assert.rejects(invalidCall, (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreToolSchemaUnavailable);
            return true;
        });

        const records = await instance.readToolCalls();
        assert.deepEqual(records.map((record) => record.status), ["completed", "completed", "failed"]);
        assert.equal(records[0]?.source, "cli");
        assert.equal(records[0]?.inputSummary, "{\"command\":\"pwd\"}");
        assert.deepEqual(records[0]?.output, { exitCode: 0 });
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
        assert.deepEqual(toolCallOutput(records[0]!, logs), { exitCode: 0, stdout });

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
            replay.events.filter((event) => jsonRecord(event.data)?.callId === callId).map((event) => event.type);

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
            (event) => event.type === "toolCall.queued" && jsonRecord(event.data)?.callId === records[0]?.callId
        );
        const firstRunning = replay.events.find(
            (event) => event.type === "toolCall.running" && jsonRecord(event.data)?.callId === records[0]?.callId
        );
        const failedEvent = replay.events.find(
            (event) => event.type === "toolCall.failed" && jsonRecord(event.data)?.callId === records[2]?.callId
        );
        const completedEvent = replay.events.find(
            (event) => event.type === "toolCall.completed" && jsonRecord(event.data)?.callId === records[0]?.callId
        );

        assert.deepEqual(firstQueued?.data, {
            callId: records[0]?.callId,
            inputSummary: "{\"command\":\"pwd\"}",
            queuedAt: jsonRecord(firstQueued?.data)?.queuedAt,
            source: "cli",
            startedAt: jsonRecord(firstQueued?.data)?.startedAt,
            status: "queued",
            toolName: "bash_run"
        });
        assert.deepEqual(firstRunning?.data, {
            callId: records[0]?.callId,
            inputSummary: "{\"command\":\"pwd\"}",
            source: "cli",
            startedAt: jsonRecord(firstQueued?.data)?.startedAt,
            status: "running",
            toolName: "bash_run"
        });
        assert.equal(jsonRecord(completedEvent?.data)?.output, undefined);
        assert.deepEqual(records[0]?.output, { exitCode: 0 });
        assert.deepEqual(failedEvent?.data, {
            callId: records[2]?.callId,
            completedAt: jsonRecord(failedEvent?.data)?.completedAt,
            errorCode: errorCodes.coreToolSchemaUnavailable,
            inputSummary: "{\"bad\":true}",
            source: "cli",
            startedAt: jsonRecord(failedEvent?.data)?.startedAt,
            status: "failed",
            toolName: "bash_run"
        });

        await instance.stop();
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance waits for approval before invoking tools and records approval decisions", async () => {
    const homeDirectory = await createTestTempDirectory("instance-approval");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        homeDirectory,
        name: asInstanceName("task-6-approval"),
        transport: harness.transport
    });

    try {
        await instance.start();
        const beforeInvokeCount = harness.requestedMethods();
        const callPromise = instance.callTool(
            "bash_run",
            { command: "pwd" },
            { source: "cli", workspace: homeDirectory },
        );

        const pendingApproval = await waitForPendingApproval(instance);
        assert.equal(harness.requestedMethods(), beforeInvokeCount);
        const approvals = await instance.listApprovals();
        assert.equal(approvals.length, 1);
        assert.equal(approvals[0]?.status, "pending");
        assert.equal(approvals[0]?.source, "cli");
        assert.equal(approvals[0]?.workspace, homeDirectory);

        const approvalId = pendingApproval.approvalId;
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
        assert.equal(jsonRecord(result)?.stdout, "/tmp/workspace\n");

        const records = await instance.readToolCalls();
        assert.equal(records[0]?.status, "completed");
        assert.equal(records[0]?.decision, "approved");
        assert.equal(records[0]?.approvalId, approvalId);

        const approved = await instance.getApproval(approvalId);
        assert.equal(approved.status, "approved");
        assert.equal(approved.decision?.decision, "approve");
        assert.equal(approved.decision?.decidedBy, "cli");

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

test("WorkerInstance cancels a pending approval when the caller aborts", async () => {
    const homeDirectory = await createTestTempDirectory("instance-approval-cancel");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        homeDirectory,
        name: asInstanceName("task-6-approval-cancel"),
        transport: harness.transport
    });

    try {
        await instance.start();
        const beforeInvokeCount = harness.requestedMethods();
        const controller = new AbortController();
        const callPromise = instance.callTool(
            "bash_run",
            { command: "pwd" },
            { requestId: "req-cancel-approval", ctxId: "ctx-cancel", source: "mcp" },
            controller.signal
        );

        const approvalId = (await waitForPendingApproval(instance)).approvalId;
        assert.equal(harness.requestedMethods(), beforeInvokeCount);
        controller.abort("client timeout");
        await assert.rejects(
            instance.decideApproval(approvalId, {
                decidedBy: "cli",
                decision: "approve"
            }),
            (error: unknown) => {
                assert.equal((error as { code?: string }).code, errorCodes.coreApprovalAlreadyDecided);
                return true;
            }
        );

        await assert.rejects(callPromise, (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreToolCallCancelled);
            return true;
        });
        assert.equal(harness.requestedMethods(), beforeInvokeCount);
        assert.equal((await instance.getApproval(approvalId)).status, "cancelled");
        assert.deepEqual(
            (await instance.readToolCalls()).map((record) => record.status),
            ["cancelled"]
        );

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        const eventTypes = replay.events.map((event) => event.type);
        assert.equal(eventTypes.includes("approval.cancelled"), true);
        assert.equal(eventTypes.includes("toolCall.cancelled"), true);
        assert.equal(eventTypes.includes("toolCall.running"), false);
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance stop cancels pending approvals before stopping the worker", async () => {
    const homeDirectory = await createTestTempDirectory("instance-stop-pending-approval");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        homeDirectory,
        name: asInstanceName("task-6-stop-pending-approval"),
        transport: harness.transport
    });

    try {
        await instance.start();
        const callPromise = instance.callTool(
            "bash_run",
            { command: "pwd" },
            { requestId: "req-stop-pending", ctxId: "ctx-stop-pending", source: "mcp" },
        );
        const approvalId = (await waitForPendingApproval(instance)).approvalId;

        const stopped = await instance.stop();
        assert.equal(stopped.daemonState, "stopped");
        await assert.rejects(callPromise, (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreToolCallCancelled);
            return true;
        });
        assert.equal((await instance.getApproval(approvalId)).status, "cancelled");
        assert.deepEqual(
            (await instance.readToolCalls()).map((record) => record.status),
            ["cancelled"],
        );
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance cancellation API terminates a pending approval before tool execution", async () => {
    const homeDirectory = await createTestTempDirectory("instance-approval-admin-cancel");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        homeDirectory,
        name: asInstanceName("task-6-approval-admin-cancel"),
        transport: harness.transport
    });

    try {
        await instance.start();
        const beforeInvokeCount = harness.requestedMethods();
        const callPromise = instance.callTool(
            "bash_run",
            { command: "pwd" },
            { requestId: "req-admin-cancel", ctxId: "ctx-disabled", source: "mcp" },
        );
        const approvalId = (await waitForPendingApproval(instance)).approvalId;

        const cancelled = await instance.cancelApproval(
            approvalId,
            "Context ctx-disabled was disabled.",
        );
        assert.equal(cancelled.status, "cancelled");
        await assert.rejects(callPromise, (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreToolCallCancelled);
            return true;
        });
        assert.equal(harness.requestedMethods(), beforeInvokeCount);
        assert.equal((await instance.getApproval(approvalId)).status, "cancelled");
        assert.deepEqual(
            (await instance.readToolCalls()).map((record) => record.status),
            ["cancelled"],
        );
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance denies and expires approval-gated calls without invoking tools", async () => {
    const homeDirectory = await createTestTempDirectory("instance-approval-fail");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        approvalTimeout: { ms: 40 },
        homeDirectory,
        name: asInstanceName("task-6-approval-fail"),
        transport: harness.transport
    });

    try {
        await instance.start();

        const beforeDeniedInvokeCount = harness.requestedMethods();
        const deniedPromise = instance.callTool("bash_run", { command: "pwd" }, { requestId: "req-deny", source: "mcp" });
        const deniedApprovalId = (await waitForPendingApproval(instance)).approvalId;
        assert.equal(harness.requestedMethods(), beforeDeniedInvokeCount);
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

test("WorkerInstance restores a stopped disconnected snapshot when start fails", async () => {
    const homeDirectory = await createTestTempDirectory("instance-start-failure");
    const transport: WorkerCommandTransport = {
        async runWorkerCommand(command): Promise<WorkerCommandResult> {
            assert.equal(command, "start");
            return {
                exitCode: 1,
                stderr: "start failed",
                stdout: ""
            };
        },
        async spawnWorkerRpc() {
            throw new Error("rpc must not be spawned after a failed start");
        },
        async installWorker(): Promise<void> {}
    };
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("task-6-start-failure"),
        transport
    });

    try {
        await assert.rejects(instance.start(), (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreWorkerStartFailed);
            return true;
        });

        const snapshot = instance.snapshot();
        assert.equal(snapshot.daemonState, "stopped");
        assert.equal(snapshot.connectionState, "disconnected");
        assert.equal(snapshot.ready, false);
        assert.equal(snapshot.lastErrorCode, errorCodes.coreWorkerStartFailed);
        assert.equal(
            snapshot.lastErrorMessage,
            "Worker start failed for instance task-6-start-failure."
        );

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.deepEqual(replay.events.map((event) => event.type), [
            "instance.statusChanged",
            "instance.statusChanged"
        ]);
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance refreshes actual daemon state when stop fails", async () => {
    const homeDirectory = await createTestTempDirectory("instance-stop-failure");
    const harness = createWorkerInstanceHarness();
    const transport: WorkerCommandTransport = {
        ...harness.transport,
        async runWorkerCommand(command, options) {
            if (command === "stop") {
                return {
                    exitCode: 1,
                    stderr: "stop failed",
                    stdout: ""
                };
            }
            return await harness.transport.runWorkerCommand(command, options);
        }
    };
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("task-6-stop-failure"),
        transport
    });

    try {
        await instance.start();
        harness.setStatus("running");

        await assert.rejects(instance.stop(), (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreWorkerStopFailed);
            return true;
        });

        const snapshot = instance.snapshot();
        assert.equal(snapshot.daemonState, "running");
        assert.equal(snapshot.connectionState, "connected");
        assert.equal(snapshot.ready, true);
        assert.equal(snapshot.lastErrorCode, errorCodes.coreWorkerStopFailed);
        assert.equal(
            snapshot.lastErrorMessage,
            "Worker stop failed for instance task-6-stop-failure."
        );
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance refreshStatus updates snapshot from worker status without auto start", async () => {
    const homeDirectory = await createTestTempDirectory("instance-refresh");
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

test("WorkerInstance refreshStatus on a connected instance keeps ready without a transient not-ready", async () => {
    const homeDirectory = await createTestTempDirectory("instance-refresh-connected");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("task-6-refresh-connected"),
        transport: harness.transport
    });

    try {
        harness.setStatus("running");
        const connected = await instance.refreshStatus();
        assert.equal(connected.ready, true);
        assert.equal(connected.connectionState, "connected");

        const before = instance.subscribe(1);
        assert.equal(before.kind, "events");
        const beforeSeq = before.lastSeq;

        const refreshed = await instance.refreshStatus();
        assert.equal(refreshed.ready, true);
        assert.equal(refreshed.connectionState, "connected");

        const after = instance.subscribe(beforeSeq + 1);
        assert.equal(after.kind, "events");
        const transientReadyChanged = after.events.find(
            (event) => event.type === "instance.readyChanged" && (event.data as { ready?: boolean } | undefined)?.ready === false
        );
        assert.equal(transientReadyChanged, undefined, "refreshStatus must not transiently flip ready to false");
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance reconnectRpc refreshes schema after an rpc disconnect", async () => {
    const homeDirectory = await createTestTempDirectory("instance-reconnect");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("task-6-reconnect"),
        transport: harness.transport
    });

    try {
        await instance.start();
        assert.deepEqual(instance.listTools()[0]?.inputSchema, toolSchemaFor("command"));

        harness.setTools([
            {
                requiredCapabilities: ["execute"],
                description: "Run a shell command.",
                group: "bash",
                inputSchema: toolSchemaFor("cwd"),
                name: "bash_run",
                outputSchema: { type: "object" }
            }
        ]);
        harness.disconnect();
        await harness.waitForMethodCount("tools.list", 2);
        await waitFor(() => instance.snapshot().connectionState === "connected");

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

test("WorkerInstance keeps retrying automatic rpc reconnect after a transient failure", async () => {
    const homeDirectory = await createTestTempDirectory("instance-reconnect-retry");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("task-6-reconnect-retry"),
        transport: harness.transport
    });

    try {
        await instance.start();
        harness.failNextRpcStarts();
        harness.disconnect();

        await harness.waitForMethodCount("tools.list", 2);
        await waitFor(() => instance.snapshot().connectionState === "connected");
        assert.equal(instance.snapshot().connectionState, "connected");
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

type HarnessTool = {
    requiredCapabilities: ["execute"];
    description: string;
    group: string;
    inputSchema: JsonValue;
    name: string;
    outputSchema: JsonValue;
};

function createWorkerInstanceHarness(): {
    disconnect: () => void;
    failNextRpcStarts: (count?: number) => void;
    setTools: (tools: HarnessTool[]) => void;
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
    let rpcSpawnFailures = 0;
    let tools: HarnessTool[] = [
        {
            requiredCapabilities: ["execute"] as ["execute"],
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
              write(value: JsonValue): void;
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
            if (rpcSpawnFailures > 0) {
                rpcSpawnFailures -= 1;
                throw new Error("transient rpc spawn failure");
            }
            const stdout = new PassThrough();
            const stdin = new PassThrough();
            const stderr = new PassThrough();
            const reader = new FrameBuffer();
            const write = (value: JsonValue) => {
                stdout.write(encodeFrame(encodeWorkerRpcMessage(value)));
            };
            let exitResolve: ((value: { code: number | null; signal: NodeJS.Signals | null }) => void) | undefined;

            stdin.on("data", (chunk: Uint8Array) => {
                const frames = reader.push(chunk);

                for (const payload of frames) {
                    const frame = decodeWorkerRpcMessage(payload);
                    if (!isRequestFrame(frame)) {
                        continue;
                    }

                    const pendingIds = pending.get(frame.method) ?? [];
                    pendingIds.push(frame.id);
                    pending.set(frame.method, pendingIds);
                    requestMethods.push(frame.method);
                    methodWaiters.get(frame.method)?.splice(0).forEach((resolve) => resolve());

                    if (frame.method === "worker.ping" || frame.method === "worker.handshake" || frame.method === "tools.list") {
                        write(createLifecycleResponse(frame.method, frame.id, tools) as unknown as JsonValue);
                    }
                }
            });

            activeProcess = { stdout, write };
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
        failNextRpcStarts(count = 1) {
            rpcSpawnFailures = count;
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
            if (requestIds === undefined) {
                throw new Error(`No pending request for ${method}.`);
            }
            const requestId = requestIds.shift();
            if (requestId === undefined) {
                throw new Error(`No pending request for ${method}.`);
            }

            if (requestIds.length === 0) {
                pending.delete(method);
            }

            activeProcess?.write({
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
                const observe = () => {
                    if (requestMethods.filter((value) => value === method).length >= count) {
                        resolve();
                        return;
                    }

                    const waiters = methodWaiters.get(method) ?? [];
                    waiters.push(observe);
                    methodWaiters.set(method, waiters);
                };

                observe();
            });
        }
    };
}


function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
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
    tools: HarnessTool[]
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
                capabilities: { cancel: true, streaming: false, tools: true },
                instance: "task-6-harness",
                platform: { arch: "x64", os: "linux" },
                protocolVersion: WORKER_PROTOCOL_VERSION,
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

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for condition.");
}

async function waitForPendingApproval(
    instance: ReturnType<WorkerInstanceFactory["create"]>,
): Promise<{ approvalId: string }> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        const approval = (await instance.listApprovals()).find(
            (candidate) => candidate.status === "pending",
        );
        if (approval !== undefined) {
            return { approvalId: approval.approvalId };
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("Timed out waiting for a pending approval.");
}
