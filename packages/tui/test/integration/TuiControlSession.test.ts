import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import {
    asInstanceName,
    type ApprovalRequest,
    type InstanceSnapshot,
    type JsonValue,
    type OAuthApprovalRequest,
    type ToolCallQuery,
    type ToolCallRecord
} from "@portable-devshell/shared";
import type { WorkerInstance } from "@portable-devshell/core/testing";

import {
    ControlRouteComposition,
    ControlSocketServer,
    InstanceRegistry
} from "@portable-devshell/control/testing";
import {
    createTuiClients,
    TuiControlSession,
    TuiRuntimeOperations
} from "../../src/testing.ts";
import { createTestIpcPath } from "../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("TuiControlSession refreshes a visible overview after relevant instance events", async (t) => {
    const runtimeDir = await createTestTempDirectory("tui-overview-refresh");
    const socketPath = createTestIpcPath("tui-overview", runtimeDir);
    const worker = new FakeWorker("alpha");
    const server = createServer(socketPath, worker, () => 7);
    const session = new TuiControlSession({
        clients: createTuiClients({ socketPath })
    });

    await server.start();
    t.after(async () => {
        await session.stop();
        await server.stop();
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await session.start();
    await waitFor(() => session.store.getState().connection.status === "connected");
    session.store.setSelectedPage("overview");

    const failedAt = new Date().toISOString();
    worker.addToolCall({
        callId: "overview-failure",
        completedAt: failedAt,
        error: "worker timed out",
        inputSummary: "command omitted",
        instance: asInstanceName("alpha"),
        source: "mcp",
        startedAt: failedAt,
        status: "failed",
        toolName: "bash_run"
    });
    worker.emit("toolCall.failed", {
        callId: "overview-failure",
        source: "mcp",
        toolName: "bash_run"
    });

    await waitFor(() => session.store.getState().readModel.overview?.counts.failedCalls24h === 1);
    assert.equal(
        session.store.getState().readModel.overview?.alerts.some(
            (alert) => alert.kind === "activity.failed" && alert.instance === "alpha"
        ),
        true
    );
});

test("TuiControlSession does not load details for a stopped instance during startup", async (t) => {
    const runtimeDir = await createTestTempDirectory("tui-stopped-instance-startup");
    const socketPath = createTestIpcPath("tui-stopped-instance", runtimeDir);
    const worker = new FakeWorker("alpha", {
        connectionState: "disconnected",
        daemonState: "stopped",
        ready: false,
        status: "stopped"
    });
    const server = createServer(socketPath, worker, () => 7);
    const session = new TuiControlSession({
        clients: createTuiClients({ socketPath })
    });

    await server.start();
    t.after(async () => {
        await session.stop();
        await server.stop();
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await session.start();

    assert.equal(session.store.getState().connection.status, "connected");
    assert.deepEqual(worker.logReadQueries, []);
});

test("TuiControlSession refreshes worker home metadata after RPC reconnect", async (t) => {
    const runtimeDir = await createTestTempDirectory("tui-worker-home-reconnect");
    const socketPath = createTestIpcPath("tui-worker-home-reconnect", runtimeDir);
    const worker = new FakeWorker("alpha", {
        connectionState: "disconnected",
        daemonState: "running",
        ready: false,
        status: "running",
    });
    const server = createServer(socketPath, worker, () => 7);
    const session = new TuiControlSession({
        clients: createTuiClients({ socketPath }),
    });

    await server.start();
    t.after(async () => {
        await session.stop();
        await server.stop();
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await session.start();
    assert.equal(
        session.store.getState().instances.find((instance) => instance.name === "alpha")?.homeDirectory,
        undefined,
    );

    worker.setHomeDirectory("/home/reconnected-alpha");
    worker.emit("worker.rpcConnected");

    await waitFor(() =>
        session.store.getState().instances.find((instance) => instance.name === "alpha")?.homeDirectory ===
        "/home/reconnected-alpha",
    );

    worker.setHomeDirectory(undefined);
    worker.emit("instance.readyChanged", { ready: false });
    await waitFor(() =>
        session.store.getState().instances.find((instance) => instance.name === "alpha")?.homeDirectory ===
        undefined,
    );
});

test("Comment delivery never stalls visible Audit refreshes for the bound call or later calls", async (t) => {
    const runtimeDir = await createTestTempDirectory("tui-comment-audit-refresh");
    const socketPath = createTestIpcPath("tui-comment-audit", runtimeDir);
    const worker = new FakeWorker("alpha");
    const server = createServer(socketPath, worker, () => 7);
    const session = new TuiControlSession({
        clients: createTuiClients({ socketPath }),
    });

    await server.start();
    t.after(async () => {
        await session.stop();
        await server.stop();
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await session.start();
    await waitFor(() => session.store.getState().connection.status === "connected");
    session.store.setSelectedInstance("alpha");
    session.store.setSelectedPage("audit");
    session.store.patchControlReadModel({ instanceState: { ["alpha"]: { contextMessages: [
        {
            createdAt: new Date(8).toISOString(),
            ctxId: "ctx-alpha",
            id: "message-1",
            instance: "alpha",
            status: "sent",
            text: "first guidance",
        },
        {
            createdAt: new Date(8).toISOString(),
            ctxId: "ctx-alpha",
            id: "message-2",
            instance: "alpha",
            status: "sent",
            text: "second guidance",
        },
    ] } } });

    const firstCompletedAt = new Date(10).toISOString();
    worker.addToolCall({
        callId: "comment-call",
        completedAt: firstCompletedAt,
        ctxId: "ctx-alpha",
        input: { command: "pwd" },
        inputSummary: '{"command":"pwd"}',
        instance: asInstanceName("alpha"),
        output: {
            comment: ["first guidance\n\nsecond guidance"],
            exitCode: 0,
            stderr: "",
            stdout: "/workspace\n",
        },
        source: "mcp",
        startedAt: new Date(9).toISOString(),
        status: "completed",
        toolName: "bash_run",
    });
    worker.emit("context.message.delivered", {
        callId: "comment-call",
        comment: "first guidance\n\nsecond guidance",
        ctxId: "ctx-alpha",
        deliveredAt: firstCompletedAt,
        ids: ["message-1", "message-2"],
        status: "delivered",
    });
    await waitFor(() =>
        session.store.getState().readModel.instanceState.alpha?.contextMessages?.every(
            (message) =>
                message.status === "delivered" &&
                message.callId === "comment-call",
        ) === true,
    );
    worker.emit("toolCall.completed", {
        callId: "comment-call",
        completedAt: firstCompletedAt,
        ctxId: "ctx-alpha",
        source: "mcp",
        startedAt: new Date(9).toISOString(),
        status: "completed",
        toolName: "bash_run",
    });

    await waitFor(() => {
        const call = session.store.getState().readModel.instanceState.alpha?.toolCalls?.find(
            (record) => record.callId === "comment-call",
        );
        return (
            (call?.output as { comment?: string[] } | undefined)?.comment?.[0] ===
            "first guidance\n\nsecond guidance"
        );
    });
    const readsAfterComment = worker.toolCallReadCount;

    const laterCompletedAt = new Date(20).toISOString();
    worker.addToolCall({
        callId: "later-call",
        completedAt: laterCompletedAt,
        ctxId: "ctx-alpha",
        input: { command: "printf later" },
        inputSummary: '{"command":"printf later"}',
        instance: asInstanceName("alpha"),
        output: { exitCode: 0, stderr: "", stdout: "later" },
        source: "mcp",
        startedAt: new Date(19).toISOString(),
        status: "completed",
        toolName: "bash_run",
    });
    worker.emit("toolCall.completed", {
        callId: "later-call",
        completedAt: laterCompletedAt,
        ctxId: "ctx-alpha",
        source: "mcp",
        startedAt: new Date(19).toISOString(),
        status: "completed",
        toolName: "bash_run",
    });

    await waitFor(() => {
        const call = session.store.getState().readModel.instanceState.alpha?.toolCalls?.find(
            (record) => record.callId === "later-call",
        );
        return (call?.output as { stdout?: string } | undefined)?.stdout === "later";
    });
    assert.equal(worker.toolCallReadCount > readsAfterComment, true);
});

test("TuiControlSession polls operational metrics only while Overview is visible", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const runtimeDir = await createTestTempDirectory("tui-overview-poll");
    const socketPath = createTestIpcPath("tui-overview-poll", runtimeDir);
    const worker = new FakeWorker("alpha");
    const server = createServer(socketPath, worker, () => 7);
    const session = new TuiControlSession({
        clients: createTuiClients({ socketPath }),
        overviewRefreshIntervalMs: 25
    });

    await server.start();
    t.after(async () => {
        await session.stop();
        await server.stop();
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await session.start();
    await waitFor(() => session.store.getState().connection.status === "connected");
    const hiddenPageReads = worker.toolCallReadCount;
    t.mock.timers.tick(75);
    assert.equal(worker.toolCallReadCount, hiddenPageReads);

    session.store.setSelectedPage("overview");
    t.mock.timers.tick(25);
    await waitFor(() => worker.toolCallReadCount > hiddenPageReads);

    session.store.setSelectedPage("instances");
    const afterVisibleReads = worker.toolCallReadCount;
    t.mock.timers.tick(75);
    assert.equal(worker.toolCallReadCount, afterVisibleReads);
});

test("TuiControlSession reports missing control without auto-starting it", async () => {
    const runtimeDir = await createTestTempDirectory("tui-not-running");
    const socketPath = createTestIpcPath("tui-control", runtimeDir);
    const session = new TuiControlSession({
        clients: createTuiClients({ socketPath })
    });

    try {
        await session.start();
        assert.equal(session.store.getState().connection.status, "disconnected");
        assert.equal(session.store.getState().connection.errorCode, "control.notRunning");
        assert.deepEqual(session.store.getState().instances, []);
    } finally {
        await session.stop();
        await rm(runtimeDir, { force: true, recursive: true });
    }
});

test("TuiControlSession does not poll OAuth approvals when OAuth is unavailable", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const runtimeDir = await createTestTempDirectory("tui-no-oauth-poll");
    const socketPath = createTestIpcPath("tui-control", runtimeDir);
    const worker = new FakeWorker("alpha");
    const server = createServer(socketPath, worker, () => 7);
    const session = new TuiControlSession({
        clients: createTuiClients({ socketPath })
    });

    await server.start();
    t.after(async () => {
        await session.stop();
        await server.stop();
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await session.start();
    await waitFor(() => session.store.getState().connection.status === "connected");
    const readsAfterInitialLoad = server.oauthApprovalReads();

    t.mock.timers.tick(1_000);
    assert.equal(server.oauthApprovalReads(), readsAfterInitialLoad);
});

test("TuiControlSession drops events that have no TUI presentation", async (t) => {
    const runtimeDir = await createTestTempDirectory("tui-event-filter");
    const socketPath = createTestIpcPath("tui-control", runtimeDir);
    const worker = new FakeWorker("alpha");
    const server = createServer(socketPath, worker, () => 7);
    const session = new TuiControlSession({
        clients: createTuiClients({ socketPath })
    });

    await server.start();
    t.after(async () => {
        await session.stop();
        await server.stop();
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await session.start();
    await waitFor(() => worker.subscribeFromSeqs.length === 1);
    const rawEventCount = session.store.getState().rawEvents.length;
    const subscriptionReads = worker.subscribeFromSeqs.length;
    worker.emit("mcp.sessionOpened", { sessionId: "invisible-session" });
    await waitFor(() => worker.subscribeFromSeqs.length > subscriptionReads);
    assert.equal(session.store.getState().rawEvents.length, rawEventCount);
});

test("module TUI clients send explicit instance operations and preserve start relay output", async (t) => {
    const runtimeDir = await createTestTempDirectory("tui-operations");
    const socketPath = createTestIpcPath("tui-control", runtimeDir);
    const worker = new FakeWorker("alpha");
    const server = createServer(socketPath, worker, () => 7);
    const clients = createTuiClients({ socketPath });

    t.after(async () => {
        clients.close();
        await server.stop();
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await server.start();
    await clients.service.hello();

    const refreshed = await clients.runtime.refresh("alpha");
    assert.equal(refreshed.snapshot.name, "alpha");

    const relayOutput: string[] = [];
    const started = await clients.runtime.start("alpha", {
        onOutput: (chunk) => {
            relayOutput.push(chunk);
        },
    });
    assert.equal(started.name, "alpha");
    assert.deepEqual(relayOutput, ["starting alpha\n"]);
    assert.deepEqual(await clients.runtime.stop("alpha"), started);

    const approval = await clients.tool.getApproval("alpha", "approval-1");
    assert.equal(approval.status, "pending");
    await clients.tool.decideApproval("alpha", "approval-1", "approve");
    assert.equal(worker.decisions[0]?.decision, "approve");

    const result = await clients.tool.call("alpha", "bash_run", { command: "pwd" }, "/home/alpha");
    assert.equal(jsonRecord(result)?.exitCode, 0);
    assert.equal(worker.callToolCount, 1);
});

test("TUI control restart reconnects after the socket runtime is replaced", async (t) => {
    const runtimeDir = await createTestTempDirectory("tui-control-restart");
    const socketPath = createTestIpcPath("tui-control-restart", runtimeDir);
    const worker = new FakeWorker("alpha");
    const server = createServer(socketPath, worker, () => 7, { restartable: true });
    const clients = createTuiClients({ socketPath });
    const session = new TuiControlSession({ clients, readTimeoutMs: 500 });
    const operations = new TuiRuntimeOperations({
        clients,
        operationTimeoutMs: 2_000,
        reconnectDelayMs: 10,
        session,
        store: session.store
    });

    await server.start();
    t.after(async () => {
        await session.stop();
        await server.stop();
        await rm(runtimeDir, { force: true, recursive: true });
    });
    await session.start();

    await operations.restartControl();

    assert.equal(server.restartCount(), 1);
    assert.equal(session.store.getState().connection.status, "connected");
    assert.deepEqual(await clients.service.ping(), { pong: true });
});

test("module TUI client sends an OAuth approval payload accepted by the control route", async (t) => {
    const runtimeDir = await createTestTempDirectory("tui-oauth-decision");
    const socketPath = createTestIpcPath("tui-oauth-decision", runtimeDir);
    const pending = oauthApproval("oauth-1");
    const decisions: Array<{ approvalId: string; decidedBy: string; decision: string }> = [];
    const routes = new ControlRouteComposition({
        instances: new InstanceRegistry([]),
        mcpStatus: () => ({ authMode: "oauth2", oauthReady: true, running: true }),
        oauthApprovals: () => ({
            async decide(approvalId: string, decision: "approve" | "deny", decidedBy: string) {
                decisions.push({ approvalId, decidedBy, decision });
                return { ...pending, decidedBy: "tui", status: decision === "approve" ? "approved" : "denied" };
            },
            async list() {
                return [pending];
            }
        } as never),
        shutdown() {}
    });
    const server = new ControlSocketServer({ routes, socketPath });
    const clients = createTuiClients({ socketPath });

    await server.start();
    t.after(async () => {
        clients.close();
        await server.stop();
        routes.dispose();
        await rm(runtimeDir, { force: true, recursive: true });
    });
    await clients.service.hello();

    assert.equal((await clients.mcp.listApprovals())[0]?.approvalId, "oauth-1");
    const decided = await clients.mcp.decideApproval("oauth-1", "approve");

    assert.equal(decided.status, "approved");
    assert.deepEqual(decisions, [
        { approvalId: "oauth-1", decidedBy: "tui", decision: "approve" }
    ]);
});

function jsonRecord(value: JsonValue): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}

function oauthApproval(approvalId: string): OAuthApprovalRequest {
    return {
        approvalId,
        clientId: "chatgpt-client",
        clientName: "ChatGPT",
        createdAt: "2026-08-02T00:00:00.000Z",
        expiresAt: "2026-08-02T00:05:00.000Z",
        kind: "registration",
        redirectUris: ["https://chatgpt.com/connector/callback"],
        requestedResources: ["https://devshell.example/alpha/mcp"],
        requestedScopes: ["mcp"],
        status: "pending"
    };
}

function createServer(
    socketPath: string,
    worker: FakeWorker,
    getConfigVersion: () => number,
    options: { restartable?: boolean } = {}
): {
    oauthApprovalReads(): number;
    restartCount(): number;
    start(): Promise<void>;
    stop(): Promise<void>;
} {
    const instances = new InstanceRegistry([
        {
            enabled: true,
            mcpCapabilities: [],
            mcpEnabled: false,
            mcpGroups: [],
            mcpPath: "",
            name: "alpha",
            provider: "local",
            todo: {
                async control() {
                    return { items: [], revision: 0, summary: { completed: 0, total: 0 } };
                },
                currentAssociation() {
                    return undefined;
                },
                async delete() {},
                async read() {
                    return { items: [], revision: 0, summary: { completed: 0, total: 0 } };
                },
                summaries() {
                    return [];
                },
                async write() {
                    return { items: [], revision: 0, summary: { completed: 0, total: 0 } };
                }
            },
            worker: worker as unknown as WorkerInstance
        }
    ]);
    let server!: ControlSocketServer;
    let oauthApprovalReads = 0;
    let restartCount = 0;
    const routes = new ControlRouteComposition({
        artifact: {
            listShares() { return []; },
            listTransfers() { return []; }
        } as never,
        config: {
            getConfigView() {
                return {
                    instances: [
                        {
                            enabled: true,
                            mcp: { enabled: false, path: "/alpha/mcp" },
                            name: "alpha",
                            provider: "local"
                        }
                    ],
                    mcp: { enabled: false, listenHost: "127.0.0.1", listenPort: 3210 },
                    version: getConfigVersion()
                };
            }
        } as never,
        instances,
        mcpStatus: () => ({ running: false, reason: "MCP runtime is disabled." }),
        oauthApprovals: () => ({
            async list() {
                oauthApprovalReads += 1;
                return [];
            },
        } as never),
        ...(options.restartable
            ? {
                restart: async () => {
                    restartCount += 1;
                    await server.stop();
                    server = new ControlSocketServer({ routes, socketPath });
                    await server.start();
                }
            }
            : {}),
        shutdown() {}
    });
    server = new ControlSocketServer({ routes, socketPath });
    return {
        oauthApprovalReads: () => oauthApprovalReads,
        restartCount: () => restartCount,
        start: async () => await server.start(),
        async stop() {
            await server.stop();
            routes.dispose();
        }
    };
}

class FakeWorker {
    readonly #name: string;
    #events: Array<{ at: string; data?: unknown; instanceName: string; seq: number; type: string }> = [];
    #homeDirectory?: string;
    #lastSeq = 0;
    readonly #approvals: ApprovalRequest[];
    readonly #logs: Array<{ at: string; instanceName: string; message: string; seq: number; stream: "stderr" | "stdout" }>;
    readonly #toolCalls: ToolCallRecord[];
    snapshotCallCount = 0;
    subscribeFromSeqs: number[] = [];
    logReadQueries: Array<{ limit?: number }> = [];
    toolCallReadCount = 0;
    callToolCount = 0;
    decisions: Array<{ approvalId: string; decision: string }> = [];

    constructor(
        name: string,
        private readonly initialSnapshot: Partial<InstanceSnapshot> = {}
    ) {
        this.#name = name;
        this.#logs = [
            {
                at: new Date(0).toISOString(),
                instanceName: name,
                message: "seed log line",
                seq: 1,
                stream: "stdout"
            }
        ];
        this.#toolCalls = [
            {
                callId: "seed-call",
                completedAt: new Date(0).toISOString(),
                inputSummary: "{\"cmd\":\"true\"}",
                instance: asInstanceName(name),
                source: "tui",
                startedAt: new Date(0).toISOString(),
                status: "completed",
                termination: "exited",
                toolName: "bash_run"
            }
        ];
        this.#approvals = [
            {
                approvalId: "approval-1",
                callId: "seed-call",
                createdAt: new Date(0).toISOString(),
                expiresAt: new Date(60_000).toISOString(),
                inputSummary: "{\"cmd\":\"rm\"}",
                instance: asInstanceName(name),
                reason: "needs review",
                riskLevel: "high",
                source: "tui",
                status: "pending",
                toolName: "bash_run"
            }
        ];
    }

    get handshake(): { homeDirectory: string } | undefined {
        return this.#homeDirectory === undefined
            ? undefined
            : { homeDirectory: this.#homeDirectory };
    }

    setHomeDirectory(homeDirectory: string | undefined): void {
        this.#homeDirectory = homeDirectory;
    }

    snapshot(): InstanceSnapshot {
        this.snapshotCallCount += 1;
        return {
            connectionState: "connected",
            daemonState: "running",
            lastSeq: this.#lastSeq,
            name: asInstanceName(this.#name),
            ready: true,
            status: "ready",
            ...this.initialSnapshot
        } as const;
    }

    subscribe(fromSeq = 1) {
        this.subscribeFromSeqs.push(fromSeq);

        const nextSeq = this.#events[0]?.seq ?? this.#lastSeq + 1;

        if (fromSeq < nextSeq) {
            return {
                code: "stream.gap",
                fromSeq,
                kind: "gap" as const,
                lastSeq: this.#lastSeq,
                nextSeq
            };
        }

        return {
            events: this.#events.filter((event) => event.seq >= fromSeq),
            kind: "events" as const,
            lastSeq: this.#lastSeq
        };
    }

    async readLogs(query?: { limit?: number }) {
        this.logReadQueries.push(query ?? {});
        return this.#logs;
    }

    async readToolCalls(query: ToolCallQuery = {}) {
        this.toolCallReadCount += 1;
        const callIds = query.callIds === undefined ? undefined : new Set(query.callIds);
        const filtered = this.#toolCalls.filter((record) => {
            if (callIds !== undefined && !callIds.has(record.callId)) return false;
            if (query.ctxId !== undefined && record.ctxId !== query.ctxId) return false;
            if (query.source !== undefined && record.source !== query.source) return false;
            if (query.status !== undefined && record.status !== query.status) return false;
            if (query.toolName !== undefined && record.toolName !== query.toolName) return false;
            return true;
        });
        return query.limit === undefined ? filtered : filtered.slice(-query.limit);
    }

    async listApprovals() {
        return this.#approvals;
    }

    async refreshStatus() {
        return this.snapshot();
    }

    async startInteractive(relay?: { writeOutput(chunk: string): Promise<void> }) {
        await relay?.writeOutput(`starting ${this.#name}\n`);
        return this.snapshot();
    }

    async stop() {
        return this.snapshot();
    }

    async getApproval(approvalId: string) {
        const approval = this.#approvals.find((candidate) => candidate.approvalId === approvalId);
        assert.notEqual(approval, undefined);
        return approval;
    }

    async decideApproval(approvalId: string, decision: { decision: string }) {
        this.decisions.push({ approvalId, decision: decision.decision });
        return await this.getApproval(approvalId);
    }

    async callTool() {
        this.callToolCount += 1;
        return {
            exitCode: 0,
            stderr: "",
            stdout: "ok"
        };
    }

    addToolCall(record: ToolCallRecord): void {
        this.#toolCalls.push(record);
    }

    emit(type: string, data?: Record<string, JsonValue>): void {
        const event = {
            at: new Date().toISOString(),
            data,
            instanceName: this.#name,
            seq: this.#lastSeq + 1,
            type
        };

        this.#lastSeq = event.seq;
        this.#events.push(event);
    }

    dropBefore(seq: number): void {
        this.#events = this.#events.filter((event) => event.seq >= seq);
    }
}

async function waitFor(factory: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (factory()) {
            return;
        }

        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    throw new Error("Timed out waiting for condition.");
}
