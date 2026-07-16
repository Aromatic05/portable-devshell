import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { asInstanceName, type ApprovalRequest, type JsonValue, type ToolCallRecord } from "@portable-devshell/shared";
import type { WorkerInstance } from "@portable-devshell/core/testing";

import {
    ControlRouteComposition,
    ControlSocketServer,
    InstanceRegistry
} from "@portable-devshell/control/testing";
import { createTuiClients, TuiControlSession } from "../../dist/testing.js";

test("TuiControlSession pulls instances, snapshots, subscribes, and recovers from stream.gap", async (t) => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-tui-session-"));
    const socketPath = join(runtimeDir, "control.sock");
    const worker = new FakeWorker("alpha");
    const server = createServer(socketPath, worker, () => 7);
    let socketCount = 0;
    const session = new TuiControlSession({
        clients: createTuiClients({
            socketFactory: (path) => {
                socketCount += 1;
                return createConnection(path);
            },
            socketPath
        })
    });

    worker.emit("toolCall.completed", {
        callId: "seed-1",
        source: "tui",
        toolName: "bash_run"
    });
    worker.emit("toolCall.completed", {
        callId: "seed-2",
        source: "tui",
        toolName: "bash_run"
    });

    await server.start();

    t.after(async () => {
        await session.stop();
        await server.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await session.start();
    await waitFor(() => session.store.getState().connection.status === "connected");
    await waitFor(() => worker.subscribeFromSeqs.length === 1);

    assert.equal(session.store.getState().instances.length, 1);
    assert.equal(session.store.getState().instances[0]?.enabled, true);
    assert.equal(session.store.getState().instances[0]?.provider, "local");
    assert.equal(session.store.getState().instances[0]?.defaultWorkspace, "/workspace/alpha");
    assert.equal(session.store.getState().snapshotsByInstance.alpha?.lastSeq, 2);
    assert.equal(session.store.getState().configView?.version, 7);
    assert.equal(worker.snapshotCallCount >= 2, true);
    assert.deepEqual(worker.subscribeFromSeqs, [2]);
    assert.deepEqual(worker.logReadQueries, [{ fromSeq: undefined, limit: 100 }]);
    assert.equal(session.store.getState().logsByInstance.alpha?.length, 1);
    assert.equal(session.store.getState().toolCallsByInstance.alpha?.length, 1);
    assert.equal(session.store.getState().approvalsByInstance.alpha?.length, 1);
    assert.equal(socketCount, 1);

    worker.emit("toolCall.completed", {
        callId: "live-3",
        completedAt: new Date().toISOString(),
        inputSummary: "{\"cmd\":\"pwd\"}",
        source: "tui",
        startedAt: new Date(1).toISOString(),
        status: "completed",
        toolName: "bash_run"
    });
    await waitFor(() => session.store.getState().rawEvents.some((event) => event.seq === 3));
    assert.equal(session.store.getState().toolCallsByInstance.alpha?.some((record) => record.callId === "live-3"), true);

    worker.emit("log.appended", {
        bytes: 11,
        stream: "stdout",
        tail: "hello world",
        toolName: "bash_run"
    });
    await waitFor(() => (session.store.getState().logsByInstance.alpha?.length ?? 0) >= 2);

    worker.emit("toolCall.completed", {
        callId: "live-4",
        completedAt: new Date().toISOString(),
        inputSummary: "{\"cmd\":\"ls\"}",
        source: "tui",
        startedAt: new Date(2).toISOString(),
        status: "completed",
        toolName: "bash_run"
    });
    worker.emit("toolCall.completed", {
        callId: "live-5",
        completedAt: new Date().toISOString(),
        inputSummary: "{\"cmd\":\"echo\"}",
        source: "tui",
        startedAt: new Date(3).toISOString(),
        status: "completed",
        toolName: "bash_run"
    });
    worker.dropBefore(5);

    await waitFor(() => worker.subscribeFromSeqs.includes(5));
    assert.equal(worker.snapshotCallCount >= 3, true);

    worker.emit("toolCall.completed", {
        callId: "after-gap",
        source: "tui",
        toolName: "bash_run"
    });
    await waitFor(() => session.store.getState().rawEvents.some((event) => event.seq === 6));

    await server.stop();
    await waitFor(() => session.store.getState().connection.status === "disconnected");
});

test("TuiControlSession reports missing control without auto-starting it", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-tui-not-running-"));
    const socketPath = join(runtimeDir, "control.sock");
    const session = new TuiControlSession({
        clients: createTuiClients({ socketPath })
    });

    try {
        await session.start();
        assert.equal(session.store.getState().connection.status, "disconnected");
        assert.equal(session.store.getState().connection.errorCode, "control.notRunning");
        assert.equal(session.store.getState().connection.errorMessage, "control server is not running.");
        assert.deepEqual(session.store.getState().instances, []);
    } finally {
        await session.stop();
        await rm(runtimeDir, { force: true, recursive: true });
    }
});

test("module TUI clients send explicit instance operations and preserve start relay output", async (t) => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-tui-operations-"));
    const socketPath = join(runtimeDir, "control.sock");
    const worker = new FakeWorker("alpha");
    const server = createServer(socketPath, worker, () => 7);
    const clients = createTuiClients({ socketPath });

    t.after(async () => {
        clients.close();
        await server.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await server.start();

    const refreshed = await clients.runtime.refresh("alpha");
    assert.equal(refreshed.snapshot.name, "alpha");

    const relayOutput: string[] = [];
    const started = await clients.runtime.start("alpha", {
        relay: {
            onOutput: (chunk) => {
                relayOutput.push(chunk);
            }
        },
        workspacePath: "/workspace/alpha"
    });
    assert.equal(started.name, "alpha");
    assert.deepEqual(relayOutput, ["starting alpha\n"]);
    assert.deepEqual(await clients.runtime.stop("alpha"), started);

    const approval = await clients.tool.getApproval("alpha", "approval-1");
    assert.equal(approval.status, "pending");
    await clients.tool.decideApproval("alpha", "approval-1", "approve");
    assert.equal(worker.decisions[0]?.decision, "approve");

    const result = await clients.tool.call("alpha", "bash_run", { command: "pwd" });
    assert.equal(result.exitCode, 0);
    assert.equal(worker.callToolCount, 1);
});

function createServer(socketPath: string, worker: FakeWorker, getConfigVersion: () => number): {
    start(): Promise<void>;
    stop(): Promise<void>;
} {
    const instances = new InstanceRegistry([
        {
            allowTools: [],
            enabled: true,
            mcpEnabled: false,
            mcpPath: "",
            name: "alpha",
            todo: {
                async read() {
                    return { items: [], revision: 0, summary: { completed: 0, total: 0 } };
                },
                summary() {
                    return undefined;
                }
            },
            worker: worker as unknown as WorkerInstance
        }
    ]);
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
                            provider: "local",
                            workspace: "/workspace/alpha"
                        }
                    ],
                    mcp: { auth: { mode: "none" }, enabled: false, listenHost: "127.0.0.1", listenPort: 3210 },
                    version: getConfigVersion()
                };
            }
        } as never,
        instances,
        mcpStatus: () => ({ running: false, reason: "MCP runtime is disabled." }),
        shutdown() {}
    });
    const server = new ControlSocketServer({ routes, socketPath });
    return {
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
    #lastSeq = 0;
    readonly #approvals: ApprovalRequest[];
    readonly #logs: Array<{ at: string; instanceName: string; message: string; seq: number; stream: "stderr" | "stdout" }>;
    readonly #toolCalls: ToolCallRecord[];
    snapshotCallCount = 0;
    subscribeFromSeqs: number[] = [];
    logReadQueries: Array<{ limit?: number }> = [];
    callToolCount = 0;
    decisions: Array<{ approvalId: string; decision: string }> = [];

    constructor(name: string) {
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

    snapshot() {
        this.snapshotCallCount += 1;
        return {
            connectionState: "connected",
            daemonState: "running",
            lastSeq: this.#lastSeq,
            name: asInstanceName(this.#name),
            ready: true,
            status: "ready"
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

    async readToolCalls() {
        return this.#toolCalls;
    }

    async listApprovals() {
        return this.#approvals;
    }

    async refreshStatus() {
        return this.snapshot();
    }

    async startInteractive(_workspacePath?: string, relay?: { writeOutput(chunk: string): Promise<void> }) {
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

        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error("Timed out waiting for condition.");
}
