import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { asInstanceName, type JsonValue } from "@portable-devshell/shared";
import type { WorkerInstance } from "@portable-devshell/core";

import { ControlRpcServer } from "../../../control/dist/control/rpc/ControlRpcServer.js";
import { InstanceRegistry } from "../../../control/dist/instance/registry/InstanceRegistry.js";
import { TuiControlClient, TuiControlSession } from "../../dist/index.js";

test("TuiControlSession recovers from runtime gap and control reconnect", async (t) => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-tui-session-"));
    const socketPath = join(runtimeDir, "control.sock");
    const worker = new FakeWorker("alpha");
    let configVersion = 1;
    let server = createServer(socketPath, worker, () => configVersion);

    await server.start();

    const session = new TuiControlSession({
        client: new TuiControlClient({ socketPath }),
        reconnectDelayMs: 25
    });

    t.after(async () => {
        await session.stop();
        await server.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await session.start();
    await waitFor(() => session.store.getConnection().state === "connected");
    await waitFor(() => session.store.getInstance("alpha")?.snapshot?.lastSeq === 0);

    assert.equal(session.store.getPendingApprovals("alpha")[0]?.approvalId, "approval-1");
    assert.equal(session.store.getToolAudit("alpha")[0]?.callId, "call-1");
    assert.equal((session.store.getConfigView()?.version as number | undefined) ?? 0, 1);

    worker.emit("toolCall.completed", {
        callId: "call-live-1",
        completedAt: "2026-07-09T00:00:10.000Z",
        inputSummary: "{\"command\":\"pwd\"}",
        source: "tui",
        startedAt: "2026-07-09T00:00:09.000Z",
        status: "completed",
        toolName: "bash_run"
    });
    await waitFor(() => session.store.getToolAudit("alpha").some((record) => record.callId === "call-live-1"));

    worker.emit("toolCall.completed", {
        callId: "call-gap",
        completedAt: "2026-07-09T00:00:11.000Z",
        inputSummary: "{\"command\":\"ls\"}",
        source: "tui",
        startedAt: "2026-07-09T00:00:10.000Z",
        status: "completed",
        toolName: "bash_run"
    });
    worker.dropBefore(3);

    await waitFor(() => worker.readToolCallsCount >= 2);
    await waitFor(() => worker.listApprovalsCount >= 2);
    await waitFor(() => worker.subscribeFromSeqs.includes(3));

    worker.emit("log.appended", {
        bytes: 9,
        callId: "call-gap",
        preview: "after-gap",
        source: "tui",
        stream: "stdout",
        tail: "after-gap",
        toolName: "bash_run"
    });
    await waitFor(() => session.store.getLogTail("alpha").some((entry) => entry.callId === "call-gap"));

    await server.stop();
    await waitFor(() => session.store.getConnection().state === "disconnected");

    configVersion = 2;
    server = createServer(socketPath, worker, () => configVersion);
    await server.start();

    await waitFor(() => session.store.getConnection().state === "connected");
    await waitFor(() => ((session.store.getConfigView()?.version as number | undefined) ?? 0) === 2);
});

function createServer(socketPath: string, worker: FakeWorker, getConfigVersion: () => number): ControlRpcServer {
    return new ControlRpcServer({
        configEditorService: {
            getConfigView() {
                return { instances: [{ name: "alpha" }], version: getConfigVersion() };
            }
        } as never,
        instanceRegistry: new InstanceRegistry([
            {
                allowTools: [],
                enabled: true,
                mcpEnabled: false,
                mcpPath: "",
                name: "alpha",
                worker: worker as unknown as WorkerInstance
            }
        ]),
        socketPath
    });
}

class FakeWorker {
    readonly #name: string;
    #events: Array<{ at: string; data?: unknown; instanceName: string; seq: number; type: string }> = [];
    #lastSeq = 0;
    #snapshot = {
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 0,
        name: asInstanceName("alpha"),
        ready: true,
        status: "ready"
    } as const;
    subscribeFromSeqs: number[] = [];
    readToolCallsCount = 0;
    listApprovalsCount = 0;

    constructor(name: string) {
        this.#name = name;
        this.#snapshot = {
            ...this.#snapshot,
            name: asInstanceName(name)
        };
    }

    snapshot() {
        return this.#snapshot;
    }

    async readToolCalls() {
        this.readToolCallsCount += 1;

        return [
            {
                callId: "call-1",
                completedAt: "2026-07-09T00:00:01.000Z",
                exitCode: 0,
                inputSummary: "{\"command\":\"pwd\"}",
                instance: asInstanceName(this.#name),
                source: "tui",
                startedAt: "2026-07-09T00:00:00.000Z",
                status: "completed",
                stderrBytes: 0,
                stdoutBytes: 8,
                timedOut: false,
                toolName: "bash_run"
            }
        ];
    }

    async listApprovals() {
        this.listApprovalsCount += 1;

        return [
            {
                approvalId: "approval-1",
                callId: "call-approval-1",
                createdAt: "2026-07-09T00:00:02.000Z",
                expiresAt: "2026-07-09T00:05:02.000Z",
                inputSummary: "{\"command\":\"rm -rf\"}",
                instance: asInstanceName(this.#name),
                reason: "Approval required before running bash_run.",
                riskLevel: "high",
                source: "tui",
                status: "pending",
                toolName: "bash_run"
            }
        ];
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
        this.#snapshot = {
            ...this.#snapshot,
            lastSeq: this.#lastSeq
        };
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
