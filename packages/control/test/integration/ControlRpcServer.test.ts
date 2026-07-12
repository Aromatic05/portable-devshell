import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FrameReader, FrameWriter, type JsonValue } from "@portable-devshell/shared";
import type { WorkerInstance } from "@portable-devshell/core";

import { ControlRpcServer } from "../../dist/control/rpc/ControlRpcServer.js";
import { InstanceRegistry } from "../../dist/instance/registry/InstanceRegistry.js";

async function verifyRpcMethodsOverReusedConnection(): Promise<void> {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-control-"));
    const socketPath = join(runtimeDir, "control.sock");
    const worker = new FakeWorker("alpha");
    const server = new ControlRpcServer({
        instanceRegistry: new InstanceRegistry([
            {
                tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] },
                enabled: true,
                mcpEnabled: false,
                mcpPath: "",
                name: "alpha",
                worker: worker as unknown as WorkerInstance
            }
        ]),
        socketPath
    });

    await server.start();
    const client = await RpcClient.connect(socketPath);

    try {
        const identified = await client.identifyClient("cli");
        assert.equal(identified.result.clientKind, "cli");

        const ping = await client.request("control.ping", { kind: "control" });
        assert.equal(ping.result.pong, true);

        const status = await client.request("control.status", { kind: "control" });
        assert.equal(status.result.instanceCount, 1);

        const listed = await client.request("control.listInstances", { kind: "control" });
        assert.equal(listed.result[0].name, "alpha");

        const snapshot = await client.request("instance.getSnapshot", { instance: "alpha", kind: "instance" });
        assert.equal(snapshot.result.lastSeq, 0);

        const started = await client.request("instance.start", { instance: "alpha", kind: "instance" }, { workspacePath: "/tmp/ws" });
        assert.equal(started.result.ready, true);

        const refreshed = await client.request("instance.refreshStatus", { instance: "alpha", kind: "instance" });
        assert.equal(refreshed.result.snapshot.status, "ready");
        assert.equal(worker.refreshCount, 1);

        const logs = await client.request("instance.readLogs", { instance: "alpha", kind: "instance" }, { fromSeq: 1 });
        assert.equal(logs.result.length, 1);
        assert.deepEqual(worker.lastReadLogsQuery, { fromSeq: 1, limit: 100 });

        await client.request("instance.readLogs", { instance: "alpha", kind: "instance" }, { limit: 1_000 });
        assert.deepEqual(worker.lastReadLogsQuery, { fromSeq: undefined, limit: 100 });

        const toolCalls = await client.request("instance.readToolCalls", { instance: "alpha", kind: "instance" }, { limit: 1 });
        assert.deepEqual(toolCalls.result, [
            {
                callId: "call-1",
                completedAt: "2026-07-08T00:00:01.000Z",
                exitCode: 0,
                inputSummary: "{\"command\":\"pwd\"}",
                instance: "alpha",
                source: "cli",
                startedAt: "2026-07-08T00:00:00.000Z",
                status: "completed",
                stderrBytes: 0,
                stdoutBytes: 8,
                termination: "exited",
                toolName: "bash_run"
            }
        ]);
        assert.deepEqual(worker.lastReadToolCallsQuery, { limit: 1 });

        const approvals = await client.request("instance.listApprovals", { instance: "alpha", kind: "instance" });
        assert.equal(approvals.result.length, 1);
        assert.equal(approvals.result[0].approvalId, "approval-1");

        const approval = await client.request(
            "instance.getApproval",
            { instance: "alpha", kind: "instance" },
            { approvalId: "approval-1" }
        );
        assert.equal(approval.result.status, "pending");

        const decided = await client.request(
            "instance.decideApproval",
            { instance: "alpha", kind: "instance" },
            { approvalId: "approval-1", decision: "approve", reason: "approved in rpc test", remember: true }
        );
        assert.equal(decided.result.status, "approved");
        assert.equal(worker.lastApprovalDecision?.approvalId, "approval-1");
        assert.equal(worker.lastApprovalDecision?.decision, "approve");
        assert.equal(worker.lastApprovalDecision?.decidedBy, "cli");

        const toolCall = await client.request(
            "instance.callTool",
            { instance: "alpha", kind: "instance" },
            { input: { command: "pwd" }, toolName: "bash_run" }
        );
        assert.equal(toolCall.result.exitCode, 0);
        assert.equal(worker.lastToolCall?.source, "cli");
        assert.match(String(worker.lastToolCall?.requestId ?? ""), /^req-\d+$/u);
        assert.equal(typeof worker.lastToolCall?.sessionId, "string");

        const tuiClient = await RpcClient.connect(socketPath);
        const unknownClient = await RpcClient.connect(socketPath);

        try {
            const tuiIdentified = await tuiClient.identifyClient("tui");
            assert.equal(tuiIdentified.result.clientKind, "tui");

            const tuiToolCall = await tuiClient.request(
                "instance.callTool",
                { instance: "alpha", kind: "instance" },
                { input: { command: "pwd" }, toolName: "bash_run" }
            );
            assert.equal(tuiToolCall.result.exitCode, 0);
            assert.equal(worker.lastToolCall?.source, "tui");

            const unknownToolCall = await unknownClient.request(
                "instance.callTool",
                { instance: "alpha", kind: "instance" },
                { input: { command: "pwd" }, toolName: "bash_run" }
            );
            assert.equal(unknownToolCall.ok, false);
            assert.equal(unknownToolCall.error.code, "control.clientIdentityRequired");
        } finally {
            tuiClient.close();
            unknownClient.close();
        }

        const subscribed = await client.request(
            "instance.subscribe",
            { instance: "alpha", kind: "instance" },
            { fromSeq: 1 }
        );
        assert.equal(subscribed.result.lastSeq, 3);
        assert.equal(subscribed.result.events.length, 3);

        worker.emit("toolCall.completed", { toolName: "bash_run" });
        const streamed = await client.nextEvent();
        assert.equal(streamed.seq, 4);
        assert.equal(streamed.target.instance, "alpha");

        worker.emit("toolCall.completed", { toolName: "bash_run" });
        worker.dropBefore(6);
        const runtimeGap = await client.nextEvent();
        assert.equal(runtimeGap.event, "stream.gap");
        assert.deepEqual(runtimeGap.payload, {
            instance: "alpha",
            latestSeq: 5,
            oldestAvailableSeq: 6,
            requestedFromSeq: 5
        });

        const cancelled = await client.nextEvent();
        assert.equal(cancelled.event, "stream.cancelled");
        assert.deepEqual(cancelled.payload, {
            instance: "alpha",
            reason: "gap"
        });

        const resubscribed = await client.request(
            "instance.subscribe",
            { instance: "alpha", kind: "instance" },
            { fromSeq: 6 }
        );
        assert.equal(resubscribed.ok, true);
        assert.equal(resubscribed.result.lastSeq, 5);
        assert.equal(resubscribed.result.events.length, 0);

        const stopped = await client.request("instance.stop", { instance: "alpha", kind: "instance" });
        assert.equal(stopped.result.ready, false);

        const invalidTarget = await client.request("control.ping", { kind: "invalid" });
        assert.equal(invalidTarget.ok, false);
        assert.equal(invalidTarget.error.code, "control.invalidTarget");

        const unknownMethod = await client.request("control.missing", { kind: "control" });
        assert.equal(unknownMethod.ok, false);

        const missingInstance = await client.request("instance.getSnapshot", { instance: "missing", kind: "instance" });
        assert.equal(missingInstance.ok, false);
        assert.equal(missingInstance.error.code, "control.instanceNotFound");

        worker.dropBefore(3);
        const gap = await client.request("instance.subscribe", { instance: "alpha", kind: "instance" }, { fromSeq: 1 });
        assert.equal(gap.ok, false);
        assert.equal(gap.error.code, "stream.gap");

        const shutdown = await client.request("control.shutdown", { kind: "control" });
        assert.equal(shutdown.result.accepted, true);
    } finally {
        client.close();
        await server.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    }
}

async function verifyShutdownToleratesClientDisconnect(): Promise<void> {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-control-"));
    const socketPath = join(runtimeDir, "control.sock");
    let shutdownRequested = false;
    const server = new ControlRpcServer({
        instanceRegistry: new InstanceRegistry([]),
        shutdown() {
            shutdownRequested = true;
        },
        socketPath
    });

    await server.start();

    try {
        const socket = createConnection(socketPath);
        const writer = new FrameWriter(socket);

        await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
        });

        await writer.write({
            id: "req-shutdown",
            method: "control.shutdown",
            target: { kind: "control" },
            type: "request"
        } as unknown as JsonValue);
        socket.destroy();

        await waitFor(() => shutdownRequested);
        assert.equal(shutdownRequested, true);
    } finally {
        await server.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    }
}

async function verifyInteractiveStartRelay(): Promise<void> {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-control-"));
    const socketPath = join(runtimeDir, "control.sock");
    const worker = new FakeWorker("alpha");
    worker.enableInteractiveStart();
    const server = new ControlRpcServer({
        instanceRegistry: new InstanceRegistry([
            {
                tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] },
                enabled: true,
                mcpEnabled: false,
                mcpPath: "",
                name: "alpha",
                worker: worker as unknown as WorkerInstance
            }
        ]),
        socketPath
    });

    await server.start();
    const client = await RpcClient.connect(socketPath);

    try {
        const startedPromise = client.request("instance.start", { instance: "alpha", kind: "instance" }, { workspacePath: "/tmp/ws" });
        const prompt = await client.nextRelayOutput();
        assert.equal(prompt.id, "req-1");
        assert.equal(prompt.data, "Password: ");

        await client.sendRelayInput(prompt.id, Buffer.from("secret\n"));

        const started = await startedPromise;
        assert.equal(started.result.ready, true);
        assert.equal(worker.lastInteractiveInput, "secret\n");
    } finally {
        client.close();
        await server.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    }
}

class RpcClient {
    readonly #reader = new FrameReader();
    readonly #pending = new Map<string, { reject: (error: unknown) => void; resolve: (value: Record<string, JsonValue>) => void }>();
    readonly #events: Array<Record<string, JsonValue>> = [];
    readonly #eventWaiters: Array<{ reject: (error: unknown) => void; resolve: (event: Record<string, JsonValue>) => void }> = [];
    readonly #relayOutputs: Array<Record<string, JsonValue>> = [];
    readonly #relayWaiters: Array<{ reject: (error: unknown) => void; resolve: (event: Record<string, JsonValue>) => void }> = [];
    readonly #socket;
    readonly #writer: FrameWriter;
    #counter = 0;

    private constructor(socketPath: string) {
        this.#socket = createConnection(socketPath);
        this.#writer = new FrameWriter(this.#socket);
        this.#socket.on("data", (chunk: Uint8Array) => {
            for (const frame of this.#reader.push(chunk)) {
                this.#accept(frame as Record<string, JsonValue>);
            }
        });
        this.#socket.once("close", () => {
            this.#failPending(new Error("control connection closed"));
        });
        this.#socket.once("error", (error) => {
            this.#failPending(error);
        });
    }

    static async connect(socketPath: string): Promise<RpcClient> {
        const client = new RpcClient(socketPath);
        await new Promise<void>((resolve, reject) => {
            client.#socket.once("connect", resolve);
            client.#socket.once("error", reject);
        });
        return client;
    }

    async identifyClient(clientKind: "cli" | "tui"): Promise<Record<string, JsonValue>> {
        return await this.request("control.identifyClient", { kind: "control" }, { clientKind });
    }

    async request(method: string, target: Record<string, unknown>, params?: JsonValue): Promise<Record<string, JsonValue>> {
        const id = `req-${++this.#counter}`;
        const response = new Promise<Record<string, JsonValue>>((resolve, reject) => {
            this.#pending.set(id, { reject, resolve });
        });

        await this.#writer.write({
            id,
            method,
            params,
            target,
            type: "request"
        } as unknown as JsonValue);

        return await response;
    }

    async nextEvent(): Promise<Record<string, JsonValue>> {
        const existing = this.#events.shift();

        if (existing !== undefined) {
            return existing;
        }

        return await new Promise<Record<string, JsonValue>>((resolve, reject) => {
            this.#eventWaiters.push({ reject, resolve });
        });
    }

    async nextRelayOutput(): Promise<Record<string, JsonValue>> {
        const existing = this.#relayOutputs.shift();

        if (existing !== undefined) {
            return existing;
        }

        return await new Promise<Record<string, JsonValue>>((resolve, reject) => {
            this.#relayWaiters.push({ reject, resolve });
        });
    }

    async sendRelayInput(id: string, input: Buffer): Promise<void> {
        await this.#writer.write({
            data: input.toString("base64"),
            id,
            type: "relay.input"
        } as unknown as JsonValue);
    }

    close(): void {
        this.#socket.destroy();
    }

    #accept(frame: Record<string, JsonValue>): void {
        if (frame.type === "response" && typeof frame.id === "string") {
            const pending = this.#pending.get(frame.id);

            if (pending !== undefined) {
                this.#pending.delete(frame.id);
                pending.resolve(frame);
            }

            return;
        }

        if (frame.type === "event") {
            const waiter = this.#eventWaiters.shift();

            if (waiter !== undefined) {
                waiter.resolve(frame);
                return;
            }

            this.#events.push(frame);
            return;
        }

        if (frame.type === "relay.output") {
            const waiter = this.#relayWaiters.shift();

            if (waiter !== undefined) {
                waiter.resolve(frame);
                return;
            }

            this.#relayOutputs.push(frame);
        }
    }

    #failPending(error: unknown): void {
        for (const pending of this.#pending.values()) {
            pending.reject(error);
        }

        this.#pending.clear();

        for (const waiter of this.#eventWaiters.splice(0)) {
            waiter.reject(error);
        }

        for (const waiter of this.#relayWaiters.splice(0)) {
            waiter.reject(error);
        }
    }
}

async function waitFor(factory: () => boolean, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (factory()) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error("Timed out waiting for condition.");
}

class FakeWorker {
    readonly #name: string;
    #approvals = [
        {
            approvalId: "approval-1",
            callId: "call-approval-1",
            createdAt: "2026-07-08T00:00:02.000Z",
            expiresAt: "2026-07-08T00:05:02.000Z",
            inputSummary: "{\"command\":\"pwd\"}",
            instance: "alpha",
            reason: "Approval required before running bash_run.",
            riskLevel: "medium",
            source: "cli",
            status: "pending",
            toolName: "bash_run"
        }
    ];
    #interactiveStartEnabled = false;
    #lastApprovalDecision?: { approvalId: string; decidedBy: string; decision: string; reason?: string; remember?: boolean };
    #refreshCount = 0;
    #lastReadLogsQuery?: { fromSeq?: number; limit?: number };
    #lastReadToolCallsQuery?: Record<string, unknown>;
    #lastInteractiveInput?: string;
    #lastToolCall?: { requestId?: string; sessionId?: string; source: string };
    #events: Array<{ at: string; data?: unknown; instanceName: string; seq: number; type: string }> = [];
    #lastSeq = 0;
    #logs = [
        {
            at: new Date().toISOString(),
            instanceName: "alpha",
            message: "booted\n",
            seq: 1,
            stream: "stdout"
        }
    ];
    #snapshot = {
        connectionState: "disconnected",
        daemonState: "stopped",
        lastSeq: 0,
        name: "alpha",
        ready: false,
        status: "stopped"
    };

    constructor(name: string) {
        this.#name = name;
        this.#snapshot = {
            ...this.#snapshot,
            name
        };
    }

    snapshot() {
        return this.#snapshot;
    }

    get refreshCount() {
        return this.#refreshCount;
    }

    get lastToolCall() {
        return this.#lastToolCall;
    }

    get lastApprovalDecision() {
        return this.#lastApprovalDecision;
    }

    get lastReadToolCallsQuery() {
        return this.#lastReadToolCallsQuery;
    }

    get lastReadLogsQuery() {
        return this.#lastReadLogsQuery;
    }

    get lastInteractiveInput() {
        return this.#lastInteractiveInput;
    }

    enableInteractiveStart(): void {
        this.#interactiveStartEnabled = true;
    }

    async start(_workspacePath?: string) {
        this.emit("instance.started", { workspacePath: "/tmp/ws" });
        this.#snapshot = {
            connectionState: "connected",
            daemonState: "running",
            lastSeq: this.#lastSeq,
            name: this.#name,
            ready: true,
            status: "ready"
        };
        return this.snapshot();
    }

    async startInteractive(
        workspacePath?: string,
        interactiveSession?: {
            readInput(): Promise<Buffer | undefined>;
            writeOutput(chunk: string): Promise<void>;
        }
    ) {
        if (interactiveSession === undefined || this.#interactiveStartEnabled !== true) {
            return await this.start(workspacePath);
        }

        await interactiveSession.writeOutput("Password: ");
        this.#lastInteractiveInput = (await interactiveSession.readInput())?.toString("utf8");
        return await this.start(workspacePath);
    }

    async stop() {
        this.#snapshot = {
            connectionState: "disconnected",
            daemonState: "stopped",
            lastSeq: this.#lastSeq,
            name: this.#name,
            ready: false,
            status: "stopped"
        };
        return this.snapshot();
    }

    async refreshStatus() {
        this.#refreshCount += 1;
        return this.snapshot();
    }

    async readLogs(query: { fromSeq?: number; limit?: number }) {
        this.#lastReadLogsQuery = query;
        return this.#logs.filter((entry) => entry.seq >= (query.fromSeq ?? 1));
    }

    async readToolCalls(query: Record<string, unknown> = {}) {
        this.#lastReadToolCallsQuery = query;
        return [
            {
                callId: "call-1",
                completedAt: "2026-07-08T00:00:01.000Z",
                exitCode: 0,
                inputSummary: "{\"command\":\"pwd\"}",
                instance: this.#name,
                source: "cli",
                startedAt: "2026-07-08T00:00:00.000Z",
                status: "completed",
                stderrBytes: 0,
                stdoutBytes: 8,
                termination: "exited",
                toolName: "bash_run"
            }
        ];
    }

    async listApprovals() {
        return this.#approvals;
    }

    async getApproval(approvalId: string) {
        return this.#approvals.find((approval) => approval.approvalId === approvalId);
    }

    async decideApproval(
        approvalId: string,
        input: { decidedBy: string; decision: string; reason?: string; remember?: boolean }
    ) {
        this.#lastApprovalDecision = {
            approvalId,
            ...input
        };
        this.#approvals = this.#approvals.map((approval) =>
            approval.approvalId === approvalId
                ? {
                      ...approval,
                      decision: {
                          approvalId,
                          decidedAt: "2026-07-08T00:00:03.000Z",
                          decidedBy: input.decidedBy,
                          decision: input.decision,
                          ...(input.reason === undefined ? {} : { reason: input.reason }),
                          ...(input.remember === undefined ? {} : { remember: input.remember })
                      },
                      status: input.decision === "approve" ? "approved" : "denied"
                  }
                : approval
        );
        return this.#approvals[0];
    }

    async callTool(
        _toolName: string,
        _input: JsonValue,
        context: { requestId?: string; sessionId?: string; source: string }
    ) {
        this.#lastToolCall = context;
        this.emit("toolCall.completed", { source: context.source, toolName: "bash_run" });
        return {
            exitCode: 0,
            signal: undefined,
            stderr: "",
            stdout: "/tmp/ws\n",
            termination: "exited"
        };
    }

    subscribe(fromSeq = 1) {
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

    emit(type: string, data?: unknown) {
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

    dropBefore(seq: number) {
        this.#events = this.#events.filter((event) => event.seq >= seq);
    }
}

await verifyRpcMethodsOverReusedConnection();
await verifyShutdownToleratesClientDisconnect();
await verifyInteractiveStartRelay();
