import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FrameReader, FrameWriter, type JsonValue } from "@portable-devshell/shared";
import type { WorkerInstance } from "@portable-devshell/core";

import { ControlRpcServer } from "../../dist/control/rpc/ControlRpcServer.js";
import { InstanceRegistry } from "../../dist/instance/registry/InstanceRegistry.js";

async function verifyStreamRecovery(): Promise<void> {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-stream-recovery-"));
    const socketPath = join(runtimeDir, "control.sock");
    const worker = new FakeWorker("alpha");
    const server = new ControlRpcServer({
        instanceRegistry: new InstanceRegistry([
            {
                allowTools: [],
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
        const started = await client.request("instance.start", { instance: "alpha", kind: "instance" }, { workspacePath: "/tmp/ws" });
        assert.equal(started.result.ready, true);

        const toolCall = await client.request(
            "instance.callTool",
            { instance: "alpha", kind: "instance" },
            { input: { command: "pwd" }, toolName: "bash_run" }
        );
        assert.equal(toolCall.result.exitCode, 0);

        const subscribed = await client.request(
            "instance.subscribe",
            { instance: "alpha", kind: "instance" },
            { fromSeq: 1 }
        );
        assert.equal(subscribed.result.lastSeq, 2);
        assert.equal(subscribed.result.events.length, 2);

        worker.emit("toolCall.completed", { toolName: "bash_run" });
        const streamed = await client.nextEvent();
        assert.equal(streamed.event, "toolCall.completed");
        assert.equal(streamed.seq, 3);

        worker.emit("toolCall.completed", { toolName: "bash_run" });
        worker.dropBefore(5);
        const runtimeGap = await client.nextEvent();
        assert.equal(runtimeGap.event, "stream.gap");
        assert.deepEqual(runtimeGap.payload, {
            instance: "alpha",
            latestSeq: 4,
            oldestAvailableSeq: 5,
            requestedFromSeq: 4
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
            { fromSeq: 5 }
        );
        assert.equal(resubscribed.result.lastSeq, 4);
        assert.equal(resubscribed.result.events.length, 0);

        worker.dropBefore(3);
        const initialGap = await client.request(
            "instance.subscribe",
            { instance: "alpha", kind: "instance" },
            { fromSeq: 1 }
        );
        assert.equal(initialGap.ok, false);
        assert.equal(initialGap.error.code, "stream.gap");
        assert.deepEqual(initialGap.error.details, {
            instance: "alpha",
            latestSeq: 4,
            oldestAvailableSeq: 5,
            requestedFromSeq: 1
        });

        const shutdown = await client.request("control.shutdown", { kind: "control" });
        assert.equal(shutdown.result.accepted, true);
    } finally {
        client.close();
        await server.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    }
}

class RpcClient {
    readonly #reader = new FrameReader();
    readonly #pending = new Map<string, { reject: (error: unknown) => void; resolve: (value: Record<string, any>) => void }>();
    readonly #events: Array<Record<string, any>> = [];
    readonly #eventWaiters: Array<{ reject: (error: unknown) => void; resolve: (event: Record<string, any>) => void }> = [];
    readonly #socket;
    readonly #writer: FrameWriter;
    #counter = 0;

    private constructor(socketPath: string) {
        this.#socket = createConnection(socketPath);
        this.#writer = new FrameWriter(this.#socket);
        this.#socket.on("data", (chunk: Uint8Array) => {
            for (const frame of this.#reader.push(chunk)) {
                this.#accept(frame as Record<string, any>);
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

    async request(method: string, target: Record<string, unknown>, params?: JsonValue): Promise<Record<string, any>> {
        const id = `req-${++this.#counter}`;
        const response = new Promise<Record<string, any>>((resolve, reject) => {
            this.#pending.set(id, { reject, resolve });
        });

        await this.#writer.write({
            id,
            issuedAt: new Date().toISOString(),
            method,
            params,
            target,
            type: "request"
        } as unknown as JsonValue);

        return await response;
    }

    async nextEvent(): Promise<Record<string, any>> {
        const existing = this.#events.shift();

        if (existing !== undefined) {
            return existing;
        }

        return await new Promise<Record<string, any>>((resolve, reject) => {
            this.#eventWaiters.push({ reject, resolve });
        });
    }

    close(): void {
        this.#socket.destroy();
    }

    #accept(frame: Record<string, any>): void {
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
    }
}

class FakeWorker {
    readonly #name: string;
    #lastToolCall?: { requestId?: string; sessionId?: string; source: string };
    #events: Array<{ at: string; data?: unknown; instanceName: string; seq: number; type: string }> = [];
    #lastSeq = 0;
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

    async startInteractive(workspacePath?: string) {
        return await this.start(workspacePath);
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
            timedOut: false
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

await verifyStreamRecovery();
