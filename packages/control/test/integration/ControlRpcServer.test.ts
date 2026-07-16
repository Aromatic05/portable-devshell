import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { WorkerCommandInteractiveSession, WorkerInstance } from "@portable-devshell/core";
import {
    asInstanceName,
    ClientConnection,
    createError,
    type ClientEvent,
    type ClientStream,
    type Destination,
    type JsonValue,
    type Peer
} from "@portable-devshell/shared";

import { RouteComposition } from "../../dist/composition/RouteComposition.js";
import { ControlSocketServer } from "../../dist/control/socket/ControlSocketServer.js";
import { InstanceRegistry } from "../../dist/modules/instance/registry/InstanceRegistry.js";

interface Harness {
    cleanup(): Promise<void>;
    registry: InstanceRegistry;
    routes: RouteComposition;
    server: ControlSocketServer;
    socketPath: string;
    worker: FakeWorker;
}

test("ControlSocketServer routes canonical control and instance operations over dedicated connections", async (t) => {
    const harness = await createHarness();
    t.after(() => harness.cleanup());

    assert.deepEqual((await request(harness.socketPath, "@control", "service.ping")).payload, { pong: true });
    assert.deepEqual((await request(harness.socketPath, "@control", "service.status")).payload, {
        instanceCount: 1,
        ok: true
    });

    const listed = (await request(harness.socketPath, "@control", "instance.list")).payload as Array<{
        name: string;
    }>;
    assert.equal(listed[0]?.name, "alpha");

    const snapshot = await request(harness.socketPath, asInstanceName("alpha"), "runtime.snapshot");
    assert.equal((snapshot.payload as { lastSeq: number }).lastSeq, 0);

    await request(harness.socketPath, asInstanceName("alpha"), "runtime.readLogs", { limit: 1_000 });
    assert.deepEqual(harness.worker.lastReadLogsQuery, { fromSeq: undefined, limit: 100 });

    const toolReply = await request(
        harness.socketPath,
        asInstanceName("alpha"),
        "tool.call",
        { input: { command: "pwd" }, toolName: "bash_run" },
        "tui"
    );
    assert.equal((toolReply.payload as { exitCode: number }).exitCode, 0);
    assert.equal(harness.worker.lastToolCall?.source, "tui");
    assert.equal(typeof harness.worker.lastToolCall?.requestId, "string");
    assert.equal(typeof harness.worker.lastToolCall?.ctxId, "string");

    const missingDestination = await request(
        harness.socketPath,
        asInstanceName("missing"),
        "runtime.snapshot"
    );
    assert.equal(missingDestination.error?.code, "control.invalidTarget");

    const missingOperation = await request(
        harness.socketPath,
        asInstanceName("alpha"),
        "runtime.missing"
    );
    assert.equal(missingOperation.error?.code, "control.methodNotFound");
});

test("ControlSocketServer rebuilds the immutable route snapshot after registry changes", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "portable-devshell-route-snapshot-"));
    const socketPath = join(directory, "control.sock");
    const registry = new InstanceRegistry([]);
    const routes = new RouteComposition({ instances: registry, shutdown() {} });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await server.stop().catch(() => undefined);
        routes.dispose();
        await rm(directory, { force: true, recursive: true });
    });

    const before = await request(socketPath, asInstanceName("alpha"), "runtime.snapshot");
    assert.equal(before.error?.code, "control.invalidTarget");

    registry.add(createDescriptor(new FakeWorker("alpha")));

    const after = await request(socketPath, asInstanceName("alpha"), "runtime.snapshot");
    assert.equal(after.error, undefined);
    assert.equal((after.payload as { snapshot: { name: string } }).snapshot.name, "alpha");
});

test("interactive runtime receives stream input while the root handler is still running", async (t) => {
    const harness = await createHarness();
    t.after(() => harness.cleanup());
    const client = createClient(harness.socketPath, "cli");
    const opened = await client.openStream(
        asInstanceName("alpha"),
        "runtime",
        "start",
        { workspacePath: "/tmp/ws" }
    );
    const stream: ClientStream = opened.stream;
    t.after(() => stream.close());
    assert.equal(opened.acknowledgement.replyTo === undefined, false);
    assert.notEqual(stream.id, opened.acknowledgement.replyTo);

    await stream.send("input", { data: Buffer.from("hello").toString("base64") });

    const output = await stream.nextEvent();
    assert.equal(output.name, "runtime.output");
    assert.deepEqual(output.payload, { chunk: "echo:hello" });

    const completed = await stream.nextEvent();
    assert.equal(completed.name, "stream.completed");
    assert.equal((completed.payload as { ready: boolean }).ready, true);
});

test("service.shutdown replies before invoking the shutdown action", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "portable-devshell-shutdown-reply-"));
    const socketPath = join(directory, "control.sock");
    let shutdownRequested = false;
    const routes = new RouteComposition({
        instances: new InstanceRegistry([]),
        shutdown() {
            shutdownRequested = true;
        }
    });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await server.stop().catch(() => undefined);
        routes.dispose();
        await rm(directory, { force: true, recursive: true });
    });

    const reply = await request(socketPath, "@control", "service.shutdown");
    assert.deepEqual(reply.payload, { accepted: true });
    await waitFor(() => shutdownRequested);
});

async function createHarness(): Promise<Harness> {
    const directory = await mkdtemp(join(tmpdir(), "portable-devshell-control-socket-"));
    const socketPath = join(directory, "control.sock");
    const worker = new FakeWorker("alpha");
    const registry = new InstanceRegistry([createDescriptor(worker)]);
    const routes = new RouteComposition({ instances: registry, shutdown() {} });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    return {
        async cleanup() {
            await server.stop().catch(() => undefined);
            routes.dispose();
            await rm(directory, { force: true, recursive: true });
        },
        registry,
        routes,
        server,
        socketPath,
        worker
    };
}

function createDescriptor(worker: FakeWorker) {
    return {
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
    };
}

function createClient(socketPath: string, peer: Exclude<Peer, "server">): ClientConnection {
    return new ClientConnection({
        mapError: (error) => error instanceof Error ? error : new Error(String(error)),
        mapRemoteError: (error) => createError(error),
        peer,
        socketPath
    });
}

async function request(
    socketPath: string,
    destination: Destination,
    name: string,
    payload?: JsonValue,
    peer: Exclude<Peer, "server"> = "cli"
): Promise<ClientEvent> {
    const [module, operation] = name.split(".");
    return await createClient(socketPath, peer).requestEvent(destination, module!, operation!, payload);
}

class FakeWorker {
    readonly #name: string;
    readonly #events: Array<{ at: string; data?: JsonValue; instanceName: string; seq: number; type: string }> = [];
    #lastSeq = 0;
    #ready = false;
    lastReadLogsQuery?: { fromSeq?: number; limit?: number };
    lastToolCall?: { ctxId?: string; requestId?: string; source?: string };

    constructor(name: string) {
        this.#name = name;
    }

    snapshot() {
        return {
            connectionState: this.#ready ? "connected" : "disconnected",
            daemonState: this.#ready ? "running" : "stopped",
            lastSeq: this.#lastSeq,
            name: asInstanceName(this.#name),
            ready: this.#ready,
            status: this.#ready ? "ready" : "stopped"
        };
    }

    async refreshStatus() {
        return this.snapshot();
    }

    async startInteractive(_workspacePath: string | undefined, session: WorkerCommandInteractiveSession) {
        const input = await session.readInput();
        await session.writeOutput(`echo:${input?.toString("utf8") ?? ""}`);
        this.#ready = true;
        return this.snapshot();
    }

    async stop() {
        this.#ready = false;
        return this.snapshot();
    }

    async readLogs(query: { fromSeq?: number; limit?: number }) {
        this.lastReadLogsQuery = query;
        return [
            {
                at: new Date(0).toISOString(),
                instanceName: asInstanceName(this.#name),
                message: "ready\n",
                seq: 1,
                stream: "stdout" as const
            }
        ];
    }

    async callTool(_toolName: string, _input: JsonValue, options: { ctxId?: string; requestId?: string; source?: string }) {
        this.lastToolCall = options;
        return { exitCode: 0 };
    }

    readToolCalls() {
        return [];
    }

    listApprovals() {
        return [];
    }

    getApproval() {
        throw new Error("unused");
    }

    decideApproval() {
        throw new Error("unused");
    }

    subscribe(fromSeq = 1) {
        const nextSeq = this.#events[0]?.seq ?? this.#lastSeq + 1;
        if (fromSeq < nextSeq) {
            return { kind: "gap" as const, lastSeq: this.#lastSeq, nextSeq };
        }
        return {
            events: this.#events.filter((event) => event.seq >= fromSeq),
            kind: "events" as const,
            lastSeq: this.#lastSeq
        };
    }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error("condition was not met");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
