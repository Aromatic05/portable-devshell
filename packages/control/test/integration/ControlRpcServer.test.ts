import assert from "node:assert/strict";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { WorkerCommandInteractiveSession, WorkerInstance } from "@portable-devshell/core/testing";
import type { TerminalProcess, TerminalProcessExit } from "../../src/control/terminal/TerminalProcess.ts";
import {
    asInstanceName,
    type ActiveTodoSummary,
    ClientConnection,
    MASKED_CONFIG_TOKEN,
    createDefaultControlConfig,
    createError,
    SocketChannel,
    type ClientEvent,
    type ClientStream,
    type Destination,
    type JsonValue,
    type Peer
} from "@portable-devshell/shared";

import { ControlRouteComposition } from "../../src/composition/ControlRouteComposition.ts";
import { ConfigEditorCoordinator } from "../../src/control/config/editor/ConfigEditorCoordinator.ts";
import { ControlConfigStore } from "../../src/control/config/ControlConfigStore.ts";
import { InstanceRegistry } from "../../src/control/instance/registry/InstanceRegistry.ts";
import { InstanceRegistryFactory } from "../../src/control/instance/registry/InstanceRegistryFactory.ts";
import { ControlSocketServer } from "../../src/server/socket/ControlSocketServer.ts";
import { createTestIpcPath } from "../../../../test/TestPlatformSupport.ts";
import { createTestInstanceDescriptor } from "../ControlTestFixtures.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { cleanupInOrder } from "../../../../test/TestCleanup.ts";

interface Harness {
    cleanup(): Promise<void>;
    registry: InstanceRegistry;
    routes: ControlRouteComposition;
    server: ControlSocketServer;
    socketPath: string;
    worker: FakeWorker;
}

test("ControlSocketServer routes canonical control and instance operations over dedicated connections", async (t) => {
    const harness = await createHarness();
    t.after(() => harness.cleanup());

    if (process.platform !== "win32") {
        assert.equal((await stat(harness.socketPath)).mode & 0o777, 0o600);
    }

    assert.deepEqual((await request(harness.socketPath, "@control", "service.ping")).payload, { pong: true });
    assert.deepEqual((await request(harness.socketPath, "@control", "service.status")).payload, {
        instanceCount: 1,
        ok: true,
        pid: process.pid
    });
    assert.deepEqual((await request(
        harness.socketPath,
        "@control",
        "service.hello",
        { clientKind: "tui", maxProtocolVersion: 1, minProtocolVersion: 1 },
        "tui"
    )).payload, {
        capabilities: ["request", "stream", "streamResume"],
        protocolVersion: 1
    });
    assert.equal((await request(
        harness.socketPath,
        "@control",
        "service.hello",
        { clientKind: "tui", maxProtocolVersion: 2, minProtocolVersion: 2 },
        "tui"
    )).error?.code, "protocol.versionUnsupported");
    assert.equal((await request(
        harness.socketPath,
        "@control",
        "service.hello",
        { clientKind: "web", maxProtocolVersion: 1, minProtocolVersion: 1 },
        "web"
    )).error?.code, "control.clientIdentityInvalid");

    const listed = (await request(harness.socketPath, "@control", "instance.list")).payload as Array<{
        name: string;
    }>;
    assert.equal(listed[0]?.name, "alpha");

    const overview = (await request(
        harness.socketPath,
        "@control",
        "overview.get"
    )).payload as {
        counts: { instancesTotal: number };
        health: string;
    };
    assert.equal(overview.counts.instancesTotal, 1);
    assert.equal(overview.health, "attention");

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

    const rejectedWeb = await request(
        harness.socketPath,
        asInstanceName("alpha"),
        "tool.call",
        { input: { command: "pwd" }, toolName: "bash_run" },
        "web"
    );
    assert.equal(rejectedWeb.error?.code, "control.clientIdentityInvalid");
    assert.equal(harness.worker.lastToolCall?.source, "tui");

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

test("config RPC masks the Web token across get, validate, and update responses", async (t) => {
    const directory = await createTestTempDirectory("config-rpc-secret");
    const homeDirectory = join(directory, "home");
    const socketPath = createTestIpcPath("control-config-rpc", directory);
    const strongToken = "a".repeat(48);
    const configStore = new ControlConfigStore();
    let config = createDefaultControlConfig();
    config.web.auth = { mode: "token", token: strongToken };
    await configStore.write(config, homeDirectory);

    const registry = new InstanceRegistryFactory().build(config);
    const editor = new ConfigEditorCoordinator({
        configStore,
        getConfig: () => config,
        homeDirectory,
        instanceRegistry: registry,
        runtimePreflight: { async assertAvailable() {} },
        setConfig: (next) => {
            config = next;
        }
    });
    const routes = new ControlRouteComposition({
        config: editor,
        instances: registry,
        shutdown() {}
    });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await cleanupInOrder(
            () => server.stop(),
            () => routes.dispose(),
            () => rm(directory, { force: true, recursive: true }),
        );
    });

    const getReply = await request(socketPath, "@control", "config.get");
    assert.equal(getReply.error, undefined);
    const getPayload = getReply.payload as Record<string, JsonValue>;
    assert.equal((getPayload.web as Record<string, JsonValue>).token, MASKED_CONFIG_TOKEN);
    assert.equal(JSON.stringify(getPayload).includes(strongToken), false);

    const instances = (getPayload.instances as Array<Record<string, JsonValue>>).map((instance) => {
        const security = instance.security as Record<string, JsonValue>;
        return { ...instance, security: { mode: security.mode } };
    });
    const validateReply = await request(socketPath, "@control", "config.validate", {
        ...getPayload,
        instances
    });
    assert.equal(validateReply.error, undefined);
    assert.equal(
        ((validateReply.payload as Record<string, JsonValue>).web as Record<string, JsonValue>).token,
        MASKED_CONFIG_TOKEN
    );
    assert.equal(JSON.stringify(validateReply.payload).includes(strongToken), false);

    const updateReply = await request(socketPath, "@control", "config.update", {
        web: { auth: "token", token: MASKED_CONFIG_TOKEN }
    });
    assert.equal(updateReply.error, undefined);
    assert.equal(JSON.stringify(updateReply.payload).includes(strongToken), false);
    assert.deepEqual(config.web.auth, { mode: "token", token: strongToken });
    assert.deepEqual((await configStore.readOrCreate(homeDirectory)).web.auth, {
        mode: "token",
        token: strongToken
    });
});

test("ControlSocketServer rebuilds the immutable route snapshot after registry changes", async (t) => {
    const directory = await createTestTempDirectory("route-snapshot");
    const socketPath = createTestIpcPath("control-rpc", directory);
    const registry = new InstanceRegistry([]);
    const routes = new ControlRouteComposition({ instances: registry, shutdown() {} });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await cleanupInOrder(
            () => server.stop(),
            () => routes.dispose(),
            () => rm(directory, { force: true, recursive: true }),
        );
    });

    const before = await request(socketPath, asInstanceName("alpha"), "runtime.snapshot");
    assert.equal(before.error?.code, "control.invalidTarget");

    registry.add(createDescriptor(new FakeWorker("alpha")));

    const after = await request(socketPath, asInstanceName("alpha"), "runtime.snapshot");
    assert.equal(after.error, undefined);
    assert.equal((after.payload as { snapshot: { name: string } }).snapshot.name, "alpha");
});

test("interactive runtime receives stream input while the root handler is still running", async (t) => {
    const activeTodos: ActiveTodoSummary[] = [{
        completed: 1,
        currentItem: "Verify release lifecycle",
        revision: 3,
        status: "in_progress",
        taskId: "release-review",
        title: "Release review",
        total: 2
    }];
    const harness = await createHarness(activeTodos);
    t.after(() => harness.cleanup());
    const client = createClient(harness.socketPath, "cli");
    await negotiateClient(client, "cli");
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
    assert.deepEqual(
        (completed.payload as { activeTodos?: ActiveTodoSummary[] }).activeTodos,
        activeTodos
    );

    const stopped = await request(
        harness.socketPath,
        asInstanceName("alpha"),
        "runtime.stop"
    );
    assert.deepEqual(
        (stopped.payload as { activeTodos?: ActiveTodoSummary[] }).activeTodos,
        activeTodos
    );
});

test("terminal RPC streams real session input, resize, detach, and sequence resume", async (t) => {
    const directory = await createTestTempDirectory("terminal-rpc");
    const socketPath = createTestIpcPath("terminal-rpc", directory);
    const process = new FakeTerminalProcess();
    const descriptor = createTestInstanceDescriptor(
        new FakeWorker("alpha") as unknown as WorkerInstance,
        {
            name: "alpha",
            terminal: { open: async () => process },
        },
    );
    const routes = new ControlRouteComposition({
        instances: new InstanceRegistry([descriptor]),
        shutdown() {},
    });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await cleanupInOrder(
            () => server.stop(),
            () => routes.dispose(),
            () => rm(directory, { force: true, recursive: true }),
        );
    });

    const client = createClient(socketPath, "tui");
    await negotiateClient(client, "tui");
    const opened = await client.request<{ generation: number; terminalId: string }>(
        asInstanceName("alpha"),
        "terminal",
        "open",
        { cols: 80, rows: 24 },
    );
    process.emit("before-attach");

    const attached = await client.openStream(
        asInstanceName("alpha"),
        "terminal",
        "attach",
        { fromSeq: 0, generation: opened.generation, terminalId: opened.terminalId },
    );
    t.after(() => attached.stream.close());
    assert.equal(
        ((attached.acknowledgement.payload as { session: { terminalId: string } }).session).terminalId,
        opened.terminalId,
    );
    const replay = await attached.stream.nextEvent();
    assert.equal(replay.name, "terminal.output");
    assert.deepEqual(replay.payload, { data: "before-attach", seq: 1 });

    await attached.stream.send("input", {
        clientSeq: 1,
        data: "printf ok\r",
        generation: opened.generation,
        terminalId: opened.terminalId,
        version: 1,
    });
    const inputAccepted = await attached.stream.nextEvent();
    assert.equal(inputAccepted.name, "terminal.inputAccepted");
    assert.deepEqual(inputAccepted.payload, {
        clientSeq: 1,
        generation: opened.generation,
        requestId: (inputAccepted.payload as { requestId: string }).requestId,
        terminalId: opened.terminalId,
        version: 1,
    });

    await attached.stream.send("resize", {
        clientSeq: 2,
        cols: 120,
        generation: opened.generation,
        rows: 40,
        terminalId: opened.terminalId,
        version: 1,
    });
    const resized = await attached.stream.nextEvent();
    assert.equal(resized.name, "terminal.resized");
    assert.deepEqual(resized.payload, {
        clientSeq: 2,
        generation: opened.generation,
        requestId: (resized.payload as { requestId: string }).requestId,
        terminalId: opened.terminalId,
        version: 2,
    });
    assert.deepEqual(process.inputs, ["printf ok\r"]);
    assert.deepEqual(process.resizes, [{ cols: 120, rows: 40 }]);

    process.emit("live");
    assert.deepEqual((await attached.stream.nextEvent()).payload, { data: "live", seq: 2 });
    await attached.stream.send("ack", {
        generation: opened.generation,
        terminalId: opened.terminalId,
        throughSeq: 2,
        version: 2,
    });
    attached.stream.close();
    process.emit("detached");
    assert.equal(process.killed, false);

    const resumed = await client.openStream(
        asInstanceName("alpha"),
        "terminal",
        "attach",
        { fromSeq: 2, generation: opened.generation, terminalId: opened.terminalId },
    );
    t.after(() => resumed.stream.close());
    assert.deepEqual((await resumed.stream.nextEvent()).payload, { data: "detached", seq: 3 });

    await client.request(
        asInstanceName("alpha"),
        "terminal",
        "kill",
        {
            generation: opened.generation,
            terminalId: opened.terminalId,
            version: 2,
        },
    );
    assert.equal(process.killed, true);
});

test("terminal stream cancels a slow attachment at the unacknowledged window without killing the PTY", async (t) => {
    const directory = await createTestTempDirectory("terminal-window");
    const socketPath = createTestIpcPath("terminal-window", directory);
    const process = new FakeTerminalProcess();
    const descriptor = createTestInstanceDescriptor(
        new FakeWorker("alpha") as unknown as WorkerInstance,
        { name: "alpha", terminal: { open: async () => process } },
    );
    const routes = new ControlRouteComposition({
        instances: new InstanceRegistry([descriptor]),
        shutdown() {},
        terminalMaxUnackedBytes: 8,
    });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await cleanupInOrder(
            () => server.stop(),
            () => routes.dispose(),
            () => rm(directory, { force: true, recursive: true }),
        );
    });

    const client = createClient(socketPath, "tui");
    await negotiateClient(client, "tui");
    const opened = await client.request<{ generation: number; terminalId: string }>(
        asInstanceName("alpha"),
        "terminal",
        "open",
        { cols: 80, rows: 24 },
    );
    const attached = await client.openStream(
        asInstanceName("alpha"),
        "terminal",
        "attach",
        { fromSeq: 0, generation: opened.generation, terminalId: opened.terminalId },
    );
    process.emit("12345");
    process.emit("67890");

    let cancelled = false;
    for (let index = 0; index < 4 && !cancelled; index += 1) {
        const event = await attached.stream.nextEvent();
        if (event.name === "stream.cancelled") {
            cancelled = true;
            assert.equal(event.error?.code, "stream.gap");
        }
    }
    assert.equal(cancelled, true);
    assert.equal(process.killed, false);

    const resumed = await client.openStream(
        asInstanceName("alpha"),
        "terminal",
        "attach",
        { fromSeq: 0, generation: opened.generation, terminalId: opened.terminalId },
    );
    assert.deepEqual((await resumed.stream.nextEvent()).payload, { data: "12345", seq: 1 });
    resumed.stream.close();
});

test("service.shutdown replies before invoking the shutdown action", async (t) => {
    const directory = await createTestTempDirectory("shutdown-reply");
    const socketPath = createTestIpcPath("control-rpc", directory);
    let shutdownRequested = false;
    const routes = new ControlRouteComposition({
        instances: new InstanceRegistry([]),
        shutdown() {
            shutdownRequested = true;
        }
    });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await cleanupInOrder(
            () => server.stop(),
            () => routes.dispose(),
            () => rm(directory, { force: true, recursive: true }),
        );
    });

    const reply = await request(socketPath, "@control", "service.shutdown");
    assert.deepEqual(reply.payload, { accepted: true });
    await waitFor(() => shutdownRequested);
});

async function createHarness(activeTodos: ActiveTodoSummary[] = []): Promise<Harness> {
    const directory = await createTestTempDirectory("control-socket");
    const socketPath = createTestIpcPath("control-rpc", directory);
    const worker = new FakeWorker("alpha");
    const registry = new InstanceRegistry([createDescriptor(worker, activeTodos)]);
    const routes = new ControlRouteComposition({ instances: registry, shutdown() {} });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    return {
        async cleanup() {
            await cleanupInOrder(
                () => server.stop(),
                () => routes.dispose(),
                () => rm(directory, { force: true, recursive: true }),
            );
        },
        registry,
        routes,
        server,
        socketPath,
        worker
    };
}

function createDescriptor(worker: FakeWorker, activeTodos: ActiveTodoSummary[] = []) {
    const descriptor = createTestInstanceDescriptor(worker as unknown as WorkerInstance, {
        name: "alpha"
    });
    return {
        ...descriptor,
        todo: {
            ...descriptor.todo,
            summaries: () => activeTodos
        }
    };
}

function createClient(socketPath: string, peer: Exclude<Peer, "server">): ClientConnection {
    return new ClientConnection({
        connectChannel: (signal) => SocketChannel.connect(socketPath, { signal }),
        mapError: (error) => error instanceof Error ? error : new Error(String(error)),
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer
    });
}

async function negotiateClient(
    connection: ClientConnection,
    peer: Exclude<Peer, "server">,
): Promise<void> {
    await connection.request("@control", "service", "hello", {
        clientKind: peer,
        maxProtocolVersion: 1,
        minProtocolVersion: 1,
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
    const connection = createClient(socketPath, peer);
    if (name === "service.hello") {
        try {
            return await connection.requestEvent(
                destination,
                module!,
                operation!,
                payload,
            );
        } finally {
            connection.close();
        }
    }
    try {
        const hello = await connection.requestEvent(
            "@control",
            "service",
            "hello",
            {
                clientKind: peer,
                maxProtocolVersion: 1,
                minProtocolVersion: 1,
            },
        );
        if (hello.error !== undefined) return hello;
        return await connection.requestEvent(
            destination,
            module!,
            operation!,
            payload,
        );
    } finally {
        connection.close();
    }
}

class FakeTerminalProcess implements TerminalProcess {
    readonly inputs: string[] = [];
    readonly resizes: Array<{ cols: number; rows: number }> = [];
    killed = false;
    readonly #data = new Set<(data: string) => void>();
    readonly #exit = new Set<(exit: TerminalProcessExit) => void>();

    emit(data: string): void {
        for (const listener of [...this.#data]) listener(data);
    }

    exit(exit: TerminalProcessExit): void {
        for (const listener of [...this.#exit]) listener(exit);
    }

    kill(): void {
        this.killed = true;
    }

    onData(listener: (data: string) => void): () => void {
        this.#data.add(listener);
        return () => this.#data.delete(listener);
    }

    onExit(listener: (exit: TerminalProcessExit) => void): () => void {
        this.#exit.add(listener);
        return () => this.#exit.delete(listener);
    }

    resize(cols: number, rows: number): void {
        this.resizes.push({ cols, rows });
    }

    write(data: string): void {
        this.inputs.push(data);
    }
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
