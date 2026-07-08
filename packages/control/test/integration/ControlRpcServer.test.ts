import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FrameReader, FrameWriter, type JsonValue } from "@portable-devshell/shared";
import type { WorkerInstance } from "@portable-devshell/core";

import { ControlRpcServer } from "../../dist/control/rpc/ControlRpcServer.js";
import { InstanceRegistry } from "../../dist/instance/registry/InstanceRegistry.js";

test("ControlRpcServer serves Task 9 rpc methods over reused unix socket connection", async (t) => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-control-"));
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

    t.after(async () => {
        client.close();
        await server.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    });

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

    const toolCall = await client.request(
        "instance.callTool",
        { instance: "alpha", kind: "instance" },
        { input: { command: "pwd" }, toolName: "bash_run" }
    );
    assert.equal(toolCall.result.exitCode, 0);
    assert.equal(worker.lastToolCall?.source, "cli");
    assert.match(String(worker.lastToolCall?.requestId ?? ""), /^req-\d+$/u);
    assert.equal(typeof worker.lastToolCall?.sessionId, "string");

    const subscribed = await client.request(
        "instance.subscribe",
        { instance: "alpha", kind: "instance" },
        { fromSeq: 1 }
    );
    assert.equal(subscribed.result.lastSeq, 2);
    assert.equal(subscribed.result.events.length, 2);

    worker.emit("toolCall.completed", { toolName: "bash_run" });
    const streamed = await client.nextEvent();
    assert.equal(streamed.seq, 3);
    assert.equal(streamed.target.instance, "alpha");

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
});

test("ControlRpcServer tolerates client disconnect during control.shutdown response", async (t) => {
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

    t.after(async () => {
        await server.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    });

    const socket = createConnection(socketPath);
    const writer = new FrameWriter(socket);

    await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });

    await writer.write({
        id: "req-shutdown",
        issuedAt: new Date().toISOString(),
        method: "control.shutdown",
        target: { kind: "control" },
        type: "request"
    } as unknown as JsonValue);
    socket.destroy();

    await waitFor(() => shutdownRequested);
    assert.equal(shutdownRequested, true);
});

test("ControlRpcServer relays interactive instance.start traffic over the request connection", async (t) => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-control-"));
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

    t.after(async () => {
        client.close();
        await server.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    });

    const startedPromise = client.request("instance.start", { instance: "alpha", kind: "instance" }, { workspacePath: "/tmp/ws" });
    const prompt = await client.nextRelayOutput();
    assert.equal(prompt.id, "req-1");
    assert.equal(prompt.data, "Password: ");

    await client.sendRelayInput(prompt.id, Buffer.from("secret\n"));

    const started = await startedPromise;
    assert.equal(started.result.ready, true);
    assert.equal(worker.lastInteractiveInput, "secret\n");
});

class RpcClient {
    readonly #reader = new FrameReader();
    readonly #pending = new Map<string, (value: Record<string, any>) => void>();
    readonly #events: Array<Record<string, any>> = [];
    readonly #eventWaiters: Array<(event: Record<string, any>) => void> = [];
    readonly #relayOutputs: Array<Record<string, any>> = [];
    readonly #relayWaiters: Array<(event: Record<string, any>) => void> = [];
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
        const response = new Promise<Record<string, any>>((resolve) => {
            this.#pending.set(id, resolve);
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

        return await new Promise<Record<string, any>>((resolve) => {
            this.#eventWaiters.push(resolve);
        });
    }

    async nextRelayOutput(): Promise<Record<string, any>> {
        const existing = this.#relayOutputs.shift();

        if (existing !== undefined) {
            return existing;
        }

        return await new Promise<Record<string, any>>((resolve) => {
            this.#relayWaiters.push(resolve);
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

    #accept(frame: Record<string, any>): void {
        if (frame.type === "response" && typeof frame.id === "string") {
            const resolve = this.#pending.get(frame.id);

            if (resolve !== undefined) {
                this.#pending.delete(frame.id);
                resolve(frame);
            }

            return;
        }

        if (frame.type === "event") {
            const waiter = this.#eventWaiters.shift();

            if (waiter !== undefined) {
                waiter(frame);
                return;
            }

            this.#events.push(frame);
            return;
        }

        if (frame.type === "relay.output") {
            const waiter = this.#relayWaiters.shift();

            if (waiter !== undefined) {
                waiter(frame);
                return;
            }

            this.#relayOutputs.push(frame);
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
    #refreshCount = 0;
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

    get lastInteractiveInput() {
        return this.#lastInteractiveInput;
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
        if (interactiveSession === undefined) {
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

    async readLogs(query: { fromSeq?: number }) {
        return this.#logs.filter((entry) => entry.seq >= (query.fromSeq ?? 1));
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
