import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import {
    asInstanceName,
    type ApprovalRequest,
    type ConversationEntry,
    type InstanceSnapshot,
    type JsonValue,
    type McpContextRecord,
    type OAuthApprovalRequest,
    type ToolCallQuery,
    type ToolCallRecord,
    type ContextMessageRecord,
} from "@portable-devshell/shared";
import { type WorkerInstance } from "@portable-devshell/core/testing";
import {
    ControlRouteComposition,
    ControlSocketServer,
    InstanceRegistry,
} from "@portable-devshell/control/testing";
import {
    createTuiDomainSession,
    TuiControlSession,
    TuiRuntimeOperations,
    TuiAppStore,
    TuiKeyDispatcher,
    auditInputText,
} from "../../../src/testing.ts";
import { createTestIpcPath } from "../../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

{
    test("TuiControlSession refreshes a visible overview after relevant instance events", async (t) => {
        const runtimeDir = await createTestTempDirectory(
            "tui-overview-refresh",
        );
        const socketPath = createTestIpcPath("tui-overview", runtimeDir);
        const worker = new FakeWorker("alpha");
        const server = createServer(socketPath, worker, () => 7);
        const domains = createTuiDomainSession({ socketPath });
        const session = new TuiControlSession({ domains });

        await server.start();
        t.after(async () => {
            await session.stop();
            await server.stop();
            await rm(runtimeDir, { force: true, recursive: true });
        });

        await session.start();
        await waitFor(
            () => session.store.getState().connection.status === "connected",
        );
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
            toolName: "bash_run",
        });
        worker.emit("toolCall.failed", {
            callId: "overview-failure",
            source: "mcp",
            toolName: "bash_run",
        });
        await session.refreshOverview();

        await waitFor(
            () =>
                session.domains.overview.state.overview?.counts
                    .failedCalls24h === 1,
        );
        assert.equal(
            session.domains.overview.state.overview?.alerts.some(
                (alert) =>
                    alert.kind === "activity.failed" &&
                    alert.instance === "alpha",
            ),
            true,
        );
    });

    test("TuiControlSession does not load details for a stopped instance during startup", async (t) => {
        const runtimeDir = await createTestTempDirectory(
            "tui-stopped-instance-startup",
        );
        const socketPath = createTestIpcPath(
            "tui-stopped-instance",
            runtimeDir,
        );
        const worker = new FakeWorker("alpha", {
            connectionState: "disconnected",
            daemonState: "stopped",
            ready: false,
            status: "stopped",
        });
        const server = createServer(socketPath, worker, () => 7);
        const domains = createTuiDomainSession({ socketPath });
        const session = new TuiControlSession({ domains });

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

    test("TuiControlSession loads exact Conversation report history", async (t) => {
        const runtimeDir = await createTestTempDirectory("tui-report-history");
        const socketPath = createTestIpcPath("tui-report-history", runtimeDir);
        const worker = new FakeWorker("alpha");
        const server = createServer(socketPath, worker, () => 7, {
            conversationEntries: () => [
                {
                    callId: "report-call",
                    createdAt: new Date(20).toISOString(),
                    ctxId: "ctx-alpha",
                    id: "report-call",
                    kind: "report",
                    text: "report text that must stay exact",
                },
            ],
        });
        const domains = createTuiDomainSession({ socketPath });
        const session = new TuiControlSession({ domains });

        await server.start();
        t.after(async () => {
            await session.stop();
            await server.stop();
            await rm(runtimeDir, { force: true, recursive: true });
        });

        await session.start();
        await session.refreshAudit("alpha");

        assert.deepEqual(
            session.domains.conversation.state.instances.alpha?.entries,
            [
                {
                    callId: "report-call",
                    createdAt: new Date(20).toISOString(),
                    ctxId: "ctx-alpha",
                    id: "report-call",
                    kind: "report",
                    text: "report text that must stay exact",
                },
            ],
        );
    });

    test("TuiControlSession refreshAudit refreshes Context registry authority", async (t) => {
        const runtimeDir = await createTestTempDirectory(
            "tui-audit-context-refresh",
        );
        const socketPath = createTestIpcPath(
            "tui-audit-context-refresh",
            runtimeDir,
        );
        const worker = new FakeWorker("alpha");
        let status: McpContextRecord["status"] = "active";
        const server = createServer(socketPath, worker, () => 7, {
            contextRecords: () => [contextRecord(status)],
        });
        const domains = createTuiDomainSession({ socketPath });
        const session = new TuiControlSession({ domains });

        await server.start();
        t.after(async () => {
            await session.stop();
            await server.stop();
            await rm(runtimeDir, { force: true, recursive: true });
        });

        await session.start();
        await waitFor(
            () =>
                session.domains.context.state.contexts[0]?.status === "active",
        );
        status = "disabled";
        const readsBefore = server.contextReads();

        await session.refreshAudit("alpha");

        assert.equal(server.contextReads() > readsBefore, true);
        assert.equal(
            session.domains.context.state.contexts[0]?.status,
            "disabled",
        );
    });

    test("TuiControlSession becomes connected before slow instance hydration completes", async (t) => {
        const runtimeDir = await createTestTempDirectory(
            "tui-fast-control-connect",
        );
        const socketPath = createTestIpcPath(
            "tui-fast-control-connect",
            runtimeDir,
        );
        const worker = new FakeWorker("alpha");
        const hydrationGate = deferred<void>();
        const hydrationStarted = deferred<void>();
        const server = createServer(socketPath, worker, () => 7, {
            onTodoRead: () => hydrationStarted.resolve(),
            todoReadGate: hydrationGate.promise,
        });
        const domains = createTuiDomainSession({ socketPath });
        const session = new TuiControlSession({ domains });

        await server.start();
        t.after(async () => {
            hydrationGate.resolve();
            await session.stop();
            await server.stop();
            await rm(runtimeDir, { force: true, recursive: true });
        });

        await session.start();
        const hydration = session.refreshInstance("alpha");
        await hydrationStarted.promise;
        let hydrated = false;
        void hydration.then(() => {
            hydrated = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(session.store.getState().connection.status, "connected");
        assert.equal(hydrated, false);

        hydrationGate.resolve();
        await hydration;
        assert.notEqual(session.domains.todo("alpha").state.todo, undefined);
    });

    test("TuiControlSession refreshes worker home metadata after RPC reconnect", async (t) => {
        const runtimeDir = await createTestTempDirectory(
            "tui-worker-home-reconnect",
        );
        const socketPath = createTestIpcPath(
            "tui-worker-home-reconnect",
            runtimeDir,
        );
        const worker = new FakeWorker("alpha", {
            connectionState: "disconnected",
            daemonState: "running",
            ready: false,
            status: "running",
        });
        const server = createServer(socketPath, worker, () => 7);
        const domains = createTuiDomainSession({ socketPath });
        const session = new TuiControlSession({ domains });

        await server.start();
        t.after(async () => {
            await session.stop();
            await server.stop();
            await rm(runtimeDir, { force: true, recursive: true });
        });

        await session.start();
        assert.equal(
            session.domains.instances.state.instances.find(
                (instance) => instance.name === "alpha",
            )?.homeDirectory,
            undefined,
        );

        worker.setHomeDirectory("/home/reconnected-alpha");
        worker.emit("worker.transportConnected");
        await session.refreshInstances();

        await waitFor(
            () =>
                session.domains.instances.state.instances.find(
                    (instance) => instance.name === "alpha",
                )?.homeDirectory === "/home/reconnected-alpha",
        );

        worker.setHomeDirectory(undefined);
        worker.emit("instance.readyChanged", { ready: false });
        await session.refreshInstances();
        await waitFor(
            () =>
                session.domains.instances.state.instances.find(
                    (instance) => instance.name === "alpha",
                )?.homeDirectory === undefined,
        );
    });

    test("Comment delivery never stalls visible Audit refreshes for the bound call or later calls", async (t) => {
        const runtimeDir = await createTestTempDirectory(
            "tui-comment-audit-refresh",
        );
        const socketPath = createTestIpcPath("tui-comment-audit", runtimeDir);
        const worker = new FakeWorker("alpha");
        const server = createServer(socketPath, worker, () => 7);
        const domains = createTuiDomainSession({ socketPath });
        const session = new TuiControlSession({ domains });

        await server.start();
        t.after(async () => {
            await session.stop();
            await server.stop();
            await rm(runtimeDir, { force: true, recursive: true });
        });

        await session.start();
        await waitFor(
            () => session.store.getState().connection.status === "connected",
        );
        session.store.setSelectedInstance("alpha");
        session.store.setSelectedPage("audit");
        await session.refreshAudit("alpha");
        worker.addMessage({
            createdAt: new Date(8).toISOString(),
            ctxId: "ctx-alpha",
            id: "message-1",
            instance: "alpha",
            status: "sent",
            text: "first guidance",
        });
        worker.addMessage({
            createdAt: new Date(8).toISOString(),
            ctxId: "ctx-alpha",
            id: "message-2",
            instance: "alpha",
            status: "sent",
            text: "second guidance",
        });
        await session.domains.messages.load(["alpha"]);

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
        await waitFor(
            () =>
                session.domains.messages.state.instances.alpha?.messages.every(
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
            const call =
                session.domains.toolCalls.state.instances.alpha?.calls.find(
                    (record) => record.callId === "comment-call",
                );
            return (
                (call?.output as { comment?: string[] } | undefined)
                    ?.comment?.[0] === "first guidance\n\nsecond guidance"
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
            const call =
                session.domains.toolCalls.state.instances.alpha?.calls.find(
                    (record) => record.callId === "later-call",
                );
            return (
                (call?.output as { stdout?: string } | undefined)?.stdout ===
                "later"
            );
        });
        assert.equal(worker.toolCallReadCount > readsAfterComment, true);
    });

    test("TuiControlSession polls operational metrics through the Overview domain", async (t) => {
        t.mock.timers.enable({ apis: ["setInterval"] });
        const runtimeDir = await createTestTempDirectory("tui-overview-poll");
        const socketPath = createTestIpcPath("tui-overview-poll", runtimeDir);
        const worker = new FakeWorker("alpha");
        const server = createServer(socketPath, worker, () => 7);
        const domains = createTuiDomainSession({ socketPath });
        const session = new TuiControlSession({ domains });

        await server.start();
        t.after(async () => {
            await session.stop();
            await server.stop();
            await rm(runtimeDir, { force: true, recursive: true });
        });

        await session.start();
        await waitFor(
            () => session.store.getState().connection.status === "connected",
        );
        const readsBeforeTick = worker.toolCallReadCount;
        t.mock.timers.tick(5_000);
        await waitFor(() => worker.toolCallReadCount > readsBeforeTick);
    });

    test("TuiControlSession reports missing control without auto-starting it", async () => {
        const runtimeDir = await createTestTempDirectory("tui-not-running");
        const socketPath = createTestIpcPath("tui-control", runtimeDir);
        const domains = createTuiDomainSession({ socketPath });
        const session = new TuiControlSession({ domains });

        try {
            await session.start();
            assert.equal(
                session.store.getState().connection.status,
                "error",
            );
            assert.equal(
                session.store.getState().connection.errorCode,
                "control.notRunning",
            );
            assert.deepEqual(session.domains.instances.state.instances, []);
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
        const domains = createTuiDomainSession({ socketPath });
        const session = new TuiControlSession({ domains });

        await server.start();
        t.after(async () => {
            await session.stop();
            await server.stop();
            await rm(runtimeDir, { force: true, recursive: true });
        });

        await session.start();
        await waitFor(
            () => session.store.getState().connection.status === "connected",
        );
        const readsAfterInitialLoad = server.oauthApprovalReads();

        t.mock.timers.tick(1_000);
        assert.equal(server.oauthApprovalReads(), readsAfterInitialLoad);
    });

    test("TuiControlSession drops events that have no TUI presentation", async (t) => {
        const runtimeDir = await createTestTempDirectory("tui-event-filter");
        const socketPath = createTestIpcPath("tui-control", runtimeDir);
        const worker = new FakeWorker("alpha");
        const server = createServer(socketPath, worker, () => 7);
        const domains = createTuiDomainSession({ socketPath });
        const session = new TuiControlSession({ domains });

        await server.start();
        t.after(async () => {
            await session.stop();
            await server.stop();
            await rm(runtimeDir, { force: true, recursive: true });
        });

        await session.start();
        await waitFor(
            () => session.store.getState().connection.status === "connected",
        );
        await session.refreshAudit("alpha");
        await waitFor(() => worker.subscribeFromSeqs.length >= 1);
        const rawEventCount = session.store.getState().rawEvents.length;
        const toolCallsBefore =
            session.domains.toolCalls.state.instances.alpha?.calls.length ?? 0;
        worker.emit("mcp.sessionOpened", { sessionId: "invisible-session" });
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        assert.equal(session.store.getState().rawEvents.length, rawEventCount);
        assert.equal(
            session.domains.toolCalls.state.instances.alpha?.calls.length ?? 0,
            toolCallsBefore,
        );
    });

    test("TUI domain session sends explicit instance operations and preserves start relay output", async (t) => {
        const runtimeDir = await createTestTempDirectory("tui-operations");
        const socketPath = createTestIpcPath("tui-control", runtimeDir);
        const worker = new FakeWorker("alpha");
        const server = createServer(socketPath, worker, () => 7);
        const domains = createTuiDomainSession({ socketPath });

        t.after(async () => {
            domains.close();
            await server.stop();
            await rm(runtimeDir, { force: true, recursive: true });
        });

        await server.start();
        await domains.service.connect();

        const runtime = domains.runtime("alpha");
        await runtime.load("alpha");
        assert.equal(runtime.state.snapshot?.name, "alpha");

        const relayOutput: string[] = [];
        const started = await runtime.start({
            onOutput: (chunk) => {
                relayOutput.push(chunk);
            },
        });
        assert.equal(started.name, "alpha");
        assert.deepEqual(relayOutput, ["starting alpha\n"]);
        assert.deepEqual(await runtime.stop(), started);

        const approval = domains.approval("alpha");
        await approval.load("alpha");
        assert.equal((await approval.get("approval-1")).status, "pending");
        await approval.decide("approval-1", "approve");
        assert.equal(worker.decisions[0]?.decision, "approve");

        const result = await domains.toolCalls.call(
            "alpha",
            "bash_run",
            { command: "pwd" },
            "/home/alpha",
        );
        assert.equal(jsonRecord(result)?.exitCode, 0);
        assert.equal(worker.callToolCount, 1);
    });

    test("TUI control restart reconnects after the socket runtime is replaced", async (t) => {
        const runtimeDir = await createTestTempDirectory("tui-control-restart");
        const socketPath = createTestIpcPath("tui-control-restart", runtimeDir);
        const worker = new FakeWorker("alpha");
        const server = createServer(socketPath, worker, () => 7, {
            restartable: true,
        });
        const domains = createTuiDomainSession({ socketPath });
        const session = new TuiControlSession({ domains });
        const operations = new TuiRuntimeOperations({
            clients: {
                artifact: domains.artifactTransport,
                config: domains.configTransport,
                reverse: domains.reverse,
                service: domains.serviceTransport,
                task: domains.taskTransport,
                tool: domains.toolTransport,
            },
            operationTimeoutMs: 2_000,
            reconnectDelayMs: 10,
            session,
            store: session.store,
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
        assert.deepEqual(await domains.serviceTransport.ping(), {
            pong: true,
        });
    });

    test("module TUI client sends an OAuth approval payload accepted by the control route", async (t) => {
        const runtimeDir = await createTestTempDirectory("tui-oauth-decision");
        const socketPath = createTestIpcPath("tui-oauth-decision", runtimeDir);
        const pending = oauthApproval("oauth-1");
        const decisions: Array<{
            approvalId: string;
            decidedBy: string;
            decision: string;
        }> = [];
        const routes = new ControlRouteComposition({
            instances: new InstanceRegistry([]),
            mcpStatus: () => ({
                authMode: "oauth2",
                oauthReady: true,
                running: true,
            }),
            oauthApprovals: () =>
                ({
                    async decide(
                        approvalId: string,
                        decision: "approve" | "deny",
                        decidedBy: string,
                    ) {
                        decisions.push({ approvalId, decidedBy, decision });
                        return {
                            ...pending,
                            decidedBy: "tui",
                            status:
                                decision === "approve" ? "approved" : "denied",
                        };
                    },
                    async list() {
                        return [pending];
                    },
                }) as never,
            shutdown() {},
        });
        const server = new ControlSocketServer({ routes, socketPath });
        const domains = createTuiDomainSession({ socketPath });

        await server.start();
        t.after(async () => {
            domains.close();
            await server.stop();
            routes.dispose();
            await rm(runtimeDir, { force: true, recursive: true });
        });
        await domains.service.connect();
        await domains.mcp.load();

        assert.equal(domains.mcp.state.approvals[0]?.approvalId, "oauth-1");
        const decided = await domains.mcp.decideApproval("oauth-1", "approve");

        assert.equal(decided.status, "approved");
        assert.deepEqual(decisions, [
            { approvalId: "oauth-1", decidedBy: "tui", decision: "approve" },
        ]);
    });

    function jsonRecord(
        value: JsonValue,
    ): Record<string, JsonValue> | undefined {
        return typeof value === "object" &&
            value !== null &&
            !Array.isArray(value)
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
            status: "pending",
        };
    }

    function createServer(
        socketPath: string,
        worker: FakeWorker,
        getConfigVersion: () => number,
        options: {
            conversationEntries?: () => ConversationEntry[];
            contextRecords?: () => McpContextRecord[];
            onTodoRead?: () => void;
            restartable?: boolean;
            todoReadGate?: Promise<void>;
        } = {},
    ): {
        contextReads(): number;
        oauthApprovalReads(): number;
        restartCount(): number;
        start(): Promise<void>;
        stop(): Promise<void>;
    } {
        const instances = new InstanceRegistry([
            {
                approval: {
                    async cancel() {
                        return {} as ApprovalRequest;
                    },
                    close() {},
                    async decideApproval(approvalId, decision) {
                        return await worker.decideApproval(
                            approvalId,
                            decision,
                        );
                    },
                    async getApproval(approvalId) {
                        return await worker.getApproval(approvalId);
                    },
                    async listApprovals() {
                        return await worker.listApprovals();
                    },
                    async listPendingApprovals() {
                        return await worker.listPendingApprovals();
                    },
                    async retire() {},
                    setPolicy() {},
                },
                approvalReview: () => ({ decision: "continue" }),
                enabled: true,
                goal: {
                    async continuation() {
                        return {};
                    },
                    async list() {
                        return [];
                    },
                    async manage() {
                        return undefined;
                    },
                    async read() {
                        return undefined;
                    },
                    async recordReentry() {},
                    async stopAll() {
                        return [];
                    },
                    async touch() {},
                },
                mcpEnabled: false,
                mcpPath: "",
                modelExtensions: [],
                name: "alpha",
                provider: "local",
                todo: {
                    async cancelAll() {},
                    async control() {
                        return {
                            items: [],
                            revision: 0,
                            summary: { completed: 0, total: 0 },
                        };
                    },
                    async delete() {},
                    async read() {
                        options.onTodoRead?.();
                        await options.todoReadGate;
                        return {
                            items: [],
                            revision: 0,
                            summary: { completed: 0, total: 0 },
                        };
                    },
                    summaries() {
                        return [];
                    },
                    async write() {
                        return {
                            items: [],
                            revision: 0,
                            summary: { completed: 0, total: 0 },
                        };
                    },
                },
                worker: worker as unknown as WorkerInstance,
            },
        ]);
        let server!: ControlSocketServer;
        let contextReads = 0;
        let oauthApprovalReads = 0;
        let restartCount = 0;
        const routes = new ControlRouteComposition({
            extensionRoutes: {
                modules(scope) {
                    return scope === "control"
                        ? []
                        : [
                              {
                                  name: "message",
                                  operations: [
                                      {
                                          name: "listConversationEntries",
                                          handle: async () =>
                                              ({
                                                  entries:
                                                      options.conversationEntries?.() ??
                                                      [],
                                                  lastSeq:
                                                      worker.snapshot().lastSeq,
                                              }) as unknown as JsonValue,
                                      },
                                      {
                                          name: "listContextMessages",
                                          handle: async () =>
                                              worker.listContextMessages() as unknown as JsonValue,
                                      },
                                      {
                                          name: "queueContextMessage",
                                          handle: async (request) =>
                                              worker.queueContextMessage(
                                                  request.payload as {
                                                      ctxId: string;
                                                      text: string;
                                                  },
                                              ) as unknown as JsonValue,
                                      },
                                  ],
                              },
                          ];
                },
                onChange() {
                    return () => undefined;
                },
            },
            artifact: {
                listShares() {
                    return [];
                },
                listTransfers() {
                    return [];
                },
            } as never,
            toolCalls: {
                async call(..._args: unknown[]) {
                    return (await worker.callTool()) as unknown as JsonValue;
                },
            } as never,
            contextAdmin:
                options.contextRecords === undefined
                    ? undefined
                    : () =>
                          ({
                              async list() {
                                  contextReads += 1;
                                  return options.contextRecords!();
                              },
                          }) as never,
            config: {
                getConfigView() {
                    return {
                        instances: [
                            {
                                enabled: true,
                                mcp: { enabled: false, path: "/alpha/mcp" },
                                name: "alpha",
                                provider: "local",
                            },
                        ],
                        mcp: {
                            enabled: false,
                            listenHost: "127.0.0.1",
                            listenPort: 3210,
                        },
                        version: getConfigVersion(),
                    };
                },
            } as never,
            instances,
            tuiPages: {
                async invoke() {
                    return { items: [], title: "" };
                },
                list() {
                    return [];
                },
            } as never,
            mcpStatus: () => ({
                running: false,
                reason: "MCP runtime is disabled.",
            }),
            oauthApprovals: () =>
                ({
                    async list() {
                        oauthApprovalReads += 1;
                        return [];
                    },
                }) as never,
            ...(options.restartable
                ? {
                      restart: async () => {
                          restartCount += 1;
                          await server.stop();
                          server = new ControlSocketServer({
                              routes,
                              socketPath,
                          });
                          await server.start();
                      },
                  }
                : {}),
            shutdown() {},
        });
        server = new ControlSocketServer({ routes, socketPath });
        return {
            contextReads: () => contextReads,
            oauthApprovalReads: () => oauthApprovalReads,
            restartCount: () => restartCount,
            start: async () => await server.start(),
            async stop() {
                await server.stop();
                routes.dispose();
            },
        };
    }

    function contextRecord(
        status: McpContextRecord["status"],
    ): McpContextRecord {
        return {
            createdAt: "2026-09-10T10:00:00.000Z",
            ctxId: "ctx-alpha",
            environments: [
                { instance: "alpha", workspace: "/workspace/alpha" },
            ],
            expiresAt: "2099-09-10T10:00:00.000Z",
            lastAccessedAt: "2026-09-10T10:00:01.000Z",
            principal: "test",
            status,
        };
    }

    class FakeWorker {
        readonly #name: string;
        #events: Array<{
            at: string;
            data?: unknown;
            instanceName: string;
            seq: number;
            type: string;
        }> = [];
        #homeDirectory?: string;
        #lastSeq = 0;
        readonly #approvals: ApprovalRequest[];
        readonly #logs: Array<{
            at: string;
            instanceName: string;
            message: string;
            seq: number;
            stream: "stderr" | "stdout";
        }>;
        readonly #toolCalls: ToolCallRecord[];
        readonly #messages: ContextMessageRecord[] = [];
        snapshotCallCount = 0;
        subscribeFromSeqs: number[] = [];
        logReadQueries: Array<{ limit?: number }> = [];
        toolCallReadCount = 0;
        toolCallQueries: ToolCallQuery[] = [];
        callToolCount = 0;
        decisions: Array<{ approvalId: string; decision: string }> = [];

        constructor(
            name: string,
            private readonly initialSnapshot: Partial<InstanceSnapshot> = {},
        ) {
            this.#name = name;
            this.#logs = [
                {
                    at: new Date(0).toISOString(),
                    instanceName: name,
                    message: "seed log line",
                    seq: 1,
                    stream: "stdout",
                },
            ];
            this.#toolCalls = [
                {
                    callId: "seed-call",
                    completedAt: new Date(0).toISOString(),
                    inputSummary: '{"cmd":"true"}',
                    instance: asInstanceName(name),
                    source: "tui",
                    startedAt: new Date(0).toISOString(),
                    status: "completed",
                    termination: "exited",
                    toolName: "bash_run",
                },
            ];
            this.#approvals = [
                {
                    approvalId: "approval-1",
                    callId: "seed-call",
                    createdAt: new Date(0).toISOString(),
                    expiresAt: new Date(60_000).toISOString(),
                    inputSummary: '{"cmd":"rm"}',
                    instance: asInstanceName(name),
                    reason: "needs review",
                    riskLevel: "high",
                    source: "tui",
                    status: "pending",
                    toolName: "bash_run",
                },
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
                ...this.initialSnapshot,
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
                    nextSeq,
                };
            }

            return {
                events: this.#events.filter((event) => event.seq >= fromSeq),
                kind: "events" as const,
                lastSeq: this.#lastSeq,
            };
        }

        async readLogs(query?: { limit?: number }) {
            this.logReadQueries.push(query ?? {});
            return this.#logs;
        }

        addMessage(message: ContextMessageRecord): void {
            this.#messages.push({ ...message });
        }

        listContextMessages(): {
            messages: ContextMessageRecord[];
            lastSeq: number;
        } {
            return {
                messages: this.#messages.map((message) => ({ ...message })),
                lastSeq: this.#lastSeq,
            };
        }

        queueContextMessage(input: {
            ctxId: string;
            text: string;
        }): ContextMessageRecord {
            const queued: ContextMessageRecord = {
                createdAt: new Date().toISOString(),
                ctxId: input.ctxId,
                id: `queued-${this.#messages.length + 1}`,
                instance: this.#name,
                status: "pending",
                text: input.text,
            };
            this.#messages.push(queued);
            return queued;
        }

        async readToolCalls(query: ToolCallQuery = {}) {
            this.toolCallReadCount += 1;
            this.toolCallQueries.push(query);
            const callIds =
                query.callIds === undefined
                    ? undefined
                    : new Set(query.callIds);
            const filtered = this.#toolCalls.filter((record) => {
                if (callIds !== undefined && !callIds.has(record.callId))
                    return false;
                if (query.ctxId !== undefined && record.ctxId !== query.ctxId)
                    return false;
                if (
                    query.source !== undefined &&
                    record.source !== query.source
                )
                    return false;
                if (
                    query.status !== undefined &&
                    record.status !== query.status
                )
                    return false;
                if (
                    query.toolName !== undefined &&
                    record.toolName !== query.toolName
                )
                    return false;
                return true;
            });
            return query.limit === undefined
                ? filtered
                : filtered.slice(-query.limit);
        }

        async readToolCallFailureSummary(sinceMs: number, untilMs: number) {
            const failures = this.#toolCalls.filter((record) => {
                if (
                    record.status !== "failed" &&
                    record.status !== "queueTimeout"
                )
                    return false;
                const occurredAtMs = Date.parse(
                    record.completedAt ?? record.startedAt,
                );
                return occurredAtMs >= sinceMs && occurredAtMs <= untilMs;
            });
            return failures.length === 0
                ? { count: 0 }
                : { count: failures.length, latest: failures.at(-1)! };
        }

        async listApprovals() {
            return this.#approvals;
        }

        async listPendingApprovals() {
            return this.#approvals.filter(
                (approval) => approval.status === "pending",
            );
        }

        async refreshStatus() {
            return this.snapshot();
        }

        async startInteractive(relay?: {
            writeOutput(chunk: string): Promise<void>;
        }) {
            await relay?.writeOutput(`starting ${this.#name}\n`);
            return this.snapshot();
        }

        async stop() {
            return this.snapshot();
        }

        async getApproval(approvalId: string) {
            const approval = this.#approvals.find(
                (candidate) => candidate.approvalId === approvalId,
            );
            assert.ok(approval !== undefined);
            return approval;
        }

        async decideApproval(
            approvalId: string,
            decision: { decision: string },
        ) {
            this.decisions.push({ approvalId, decision: decision.decision });
            return await this.getApproval(approvalId);
        }

        async callTool() {
            this.callToolCount += 1;
            return {
                exitCode: 0,
                stderr: "",
                stdout: "ok",
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
                type,
            };

            this.#lastSeq = event.seq;
            this.#events.push(event);
            if (type === "context.message.delivered") {
                const ids = Array.isArray(data?.ids)
                    ? data.ids.filter(
                          (id): id is string => typeof id === "string",
                      )
                    : [];
                for (const [index, message] of this.#messages.entries()) {
                    if (!ids.includes(message.id)) continue;
                    this.#messages[index] = {
                        ...message,
                        ...(typeof data?.callId === "string"
                            ? { callId: data.callId }
                            : {}),
                        status: "delivered",
                    };
                }
            }
        }

        dropBefore(seq: number): void {
            this.#events = this.#events.filter((event) => event.seq >= seq);
        }
    }

    async function waitFor(
        factory: () => boolean,
        timeoutMs = 2_000,
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            if (factory()) {
                return;
            }

            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        throw new Error("Timed out waiting for condition.");
    }

    function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((next) => {
            resolve = next;
        });
        return { promise, resolve };
    }
}

{
    test("text input scopes preserve multi-character paste payloads", () => {
        const dispatcher = new TuiKeyDispatcher();
        const paste = "echo pasted text";

        assert.deepEqual(
            dispatcher.dispatch("search", { input: paste, key: {} }),
            [{ text: paste, type: "search.append" }],
        );
        assert.deepEqual(
            dispatcher.dispatch("contextConversation", {
                input: paste,
                key: {},
            }),
            [{ text: paste, type: "contextConversation.append" }],
        );
        assert.deepEqual(
            dispatcher.dispatch("toolForm", { input: paste, key: {} }),
            [{ text: paste, type: "toolForm.append" }],
        );
        assert.deepEqual(
            dispatcher.dispatch("form", { input: paste, key: {} }),
            [{ text: paste, type: "editor.append" }],
        );
    });

    test("audit formatting truncates deeply nested values instead of overflowing the stack", () => {
        const root: Record<string, JsonValue> = {};
        let cursor = root;
        for (let index = 0; index < 15_000; index += 1) {
            const next: Record<string, JsonValue> = {};
            cursor.next = next;
            cursor = next;
        }

        const text = auditInputText(root, undefined);

        assert.match(text, /truncated|max depth/u);
        assert.equal(text.length < 210_000, true);
    });

    test("a committed context message remains successful when the follow-up audit refresh fails", async () => {
        const store = new TuiAppStore();
        const queued: ContextMessageRecord = {
            createdAt: "2026-08-01T00:00:00.000Z",
            ctxId: "ctx-1",
            id: "message-1",
            instance: "alpha",
            status: "pending",
            text: "review this",
        };
        const domains = createTuiDomainSession();
        const operations = new TuiRuntimeOperations({
            clients: {} as never,
            operationTimeoutMs: 100,
            session: {
                commands: {
                    async queueContextMessage() {
                        domains.messages.mergeMessage("alpha", queued);
                        return queued;
                    },
                },
                async refreshAudit() {
                    throw new Error("audit refresh failed");
                },
            } as never,
            store,
        });

        try {
            await operations.queueContextMessage(
                "alpha",
                "ctx-1",
                "review this",
            );

            assert.equal(
                domains.messages.state.instances.alpha?.messages?.[0]?.id,
                "message-1",
            );
            assert.equal(
                store.getState().panelErrors["audit:alpha:operationRefresh"]
                    ?.message,
                "audit refresh failed",
            );
        } finally {
            domains.close();
        }
    });
}
