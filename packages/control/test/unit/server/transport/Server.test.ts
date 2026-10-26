import { join } from "node:path";
import { GoalService } from "../../../../../core/src/task/goal/index.ts";
import { installMcpAppReentry } from "../../../../../core/src/instance/mcpapp/Reentry.ts";
import { createTestInstanceDescriptor } from "../../../support/ControlFixtures.ts";
import { McpControlModule } from "../../../../src/server/mcp/Module.ts";
import { ControlHttpServer } from "../../../../src/server/http/index.ts";
import { createToolCallRegistry } from "../../../../src/toolcall/index.ts";
import { ControlPathHome, createDefaultControlConfig, type ToolCallApi } from "@portable-devshell/shared";
import { round4Target, barrier } from "../../../../../core/test/unit/tool/Round4Harness.ts";
import { registerApprovalToolCallReview } from "../../../../../core/src/approval/execution/ToolCallReview.ts";
import { McpEndpointDispatch } from "../../../../../mcp/src/protocol/dispatch/Dispatch.ts";
import { McpEndpointCatalog } from "../../../../../mcp/src/protocol/tool/Catalog.ts";
import { TestToolSource } from "../../../../../mcp/test/support/ToolSource.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
    CONTROL_PROTOCOL_RANGE,
    CONTROL_PROTOCOL_VERSION,
    Endpoint,
    Rpc,
    Stream,
    asInstanceName,
    createToolCallRuntime,
    createToolCallTargetTransport,
    createToolCallIngressTransport,
    createToolCallIngressTransportRoute,
    mergeControlPorts,
    createRemoteError,
    runtimeErrorCodes,
    readToolCallErrorPayload,
    attachToolCallErrorPayload,
    type ToolCallContext,
    createToolRouteModule,
    controlErrorCodes,
    type Channel,
    type ControlPortContext,
    type JsonValue,
    type ControlHostDefinition,
    type MessageStream,
} from "@portable-devshell/shared";

import { ControlTransportServer } from "../../../../src/server/transport/endpoint/Server.ts";
import type {
    ControlAcceptedChannel,
    ControlTransportAdmission,
    ControlTransportListener,
} from "../../../../src/server/transport/channel/Listener.ts";
import { negotiateControlProtocol } from "../../../../src/server/Protocol.ts";

class MemoryChannel implements Channel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #dataListeners = new Set<(data: Uint8Array) => void>();
    #closeError?: Error;
    #closed = false;
    #peer?: MemoryChannel;

    get closed(): boolean {
        return this.#closed;
    }

    bind(peer: MemoryChannel): void {
        this.#peer = peer;
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.#closed) {
            throw this.#closeError ?? new Error("Memory channel is closed.");
        }
        const peer = this.#peer;
        if (peer === undefined) {
            throw new Error("Memory channel peer is not bound.");
        }
        if (peer.#closed) {
            throw (
                peer.#closeError ?? new Error("Memory channel peer is closed.")
            );
        }
        const copy = Uint8Array.from(data);
        queueMicrotask(() => peer.#accept(copy));
    }

    onData(listener: (data: Uint8Array) => void): () => void {
        this.#dataListeners.add(listener);
        return () => this.#dataListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        if (this.#closed) {
            queueMicrotask(() => listener(this.#closeError));
            return () => undefined;
        }
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    close(error?: Error): void {
        this.#finishClose(error, true);
    }

    #accept(data: Uint8Array): void {
        if (this.#closed) {
            return;
        }
        for (const listener of [...this.#dataListeners]) {
            listener(data);
        }
    }

    #finishClose(error: Error | undefined, notifyPeer: boolean): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#closeError = error;
        for (const listener of [...this.#closeListeners]) {
            listener(error);
        }
        this.#closeListeners.clear();
        if (notifyPeer) {
            const peer = this.#peer;
            if (peer !== undefined) {
                peer.#finishClose(error, false);
            }
        }
    }
}

class MemoryControlTransportListener implements ControlTransportListener {
    readonly #admission: ControlTransportAdmission;
    #accept?: (connection: ControlAcceptedChannel) => void;
    closed = false;
    started = false;

    constructor(
        admission: ControlTransportAdmission = {
            allowedPeers: ["cli", "tui"],
            subject: { id: "uid:test", kind: "local-owner" },
        },
    ) {
        this.#admission = admission;
    }

    async start(
        accept: (connection: ControlAcceptedChannel) => void,
    ): Promise<void> {
        assert.equal(this.started, false);
        this.started = true;
        this.#accept = accept;
    }

    async close(): Promise<void> {
        this.closed = true;
        this.#accept = undefined;
    }

    connect(): Channel {
        const accept = this.#accept;
        if (accept === undefined) {
            throw new Error("Provider is not started.");
        }
        const client = new MemoryChannel();
        const server = new MemoryChannel();
        client.bind(server);
        server.bind(client);
        accept({ admission: this.#admission, channel: server });
        return client;
    }
}

class BlockingControlTransportListener implements ControlTransportListener {
    readonly started: Promise<void>;
    closeCount = 0;
    startCount = 0;
    #releaseStart!: () => void;
    #signalStarted!: () => void;

    constructor() {
        this.started = new Promise<void>((resolve) => {
            this.#signalStarted = resolve;
        });
    }

    async start(): Promise<void> {
        this.startCount += 1;
        this.#signalStarted();
        await new Promise<void>((resolve) => {
            this.#releaseStart = resolve;
        });
    }

    async close(): Promise<void> {
        this.closeCount += 1;
    }

    releaseStart(): void {
        this.#releaseStart();
    }
}

class RetryCloseControlTransportListener implements ControlTransportListener {
    readonly events: string[] = [];
    closeCount = 0;
    startCount = 0;
    #failuresRemaining: number;

    constructor(failures: number) {
        this.#failuresRemaining = failures;
    }

    async start(): Promise<void> {
        this.startCount += 1;
        this.events.push(`start:${this.startCount}`);
    }

    async close(): Promise<void> {
        this.closeCount += 1;
        this.events.push(`close:${this.closeCount}`);
        if (this.#failuresRemaining > 0) {
            this.#failuresRemaining -= 1;
            throw new Error("provider close failed");
        }
    }
}

class BlockingRetryCloseControlTransportListener implements ControlTransportListener {
    readonly cleanupStarted: Promise<void>;
    readonly events: string[] = [];
    closeCount = 0;
    startCount = 0;
    #releaseCleanup!: () => void;
    #signalCleanupStarted!: () => void;

    constructor() {
        this.cleanupStarted = new Promise<void>((resolve) => {
            this.#signalCleanupStarted = resolve;
        });
    }

    async start(): Promise<void> {
        this.startCount += 1;
        this.events.push(`start:${this.startCount}`);
    }

    async close(): Promise<void> {
        this.closeCount += 1;
        this.events.push(`close:${this.closeCount}`);
        if (this.closeCount === 1) {
            throw new Error("provider close failed");
        }
        if (this.closeCount === 2) {
            this.#signalCleanupStarted();
            await new Promise<void>((resolve) => {
                this.#releaseCleanup = resolve;
            });
        }
    }

    releaseCleanup(): void {
        this.#releaseCleanup();
    }
}

test("ControlTransportServer serves the same routes through multiple channel providers", async (t) => {
    const socketProvider = new MemoryControlTransportListener({
        allowedPeers: ["cli", "tui"],
        subject: { id: "uid:1000", kind: "local-owner" },
    });
    const webProvider = new MemoryControlTransportListener({
        allowedPeers: ["web"],
        subject: { id: "session:abc", kind: "web-session" },
    });
    const closedConnections: string[] = [];
    const routes = {
        hosts: createRouteHosts,
        onChange: () => () => undefined,
    };
    const server = new ControlTransportServer({
        listeners: [socketProvider, webProvider],
        onConnectionDetached: (connectionId) =>
            closedConnections.push(connectionId),
        routes,
    });
    await server.start();
    t.after(async () => await server.close());

    const socketConnection = createClient(socketProvider, "tui");
    const webConnection = createClient(webProvider, "web");
    t.after(() => socketConnection.close());
    t.after(() => webConnection.close());

    await assert.rejects(
        socketConnection.request("@control", "server", "ping"),
        (error: unknown) =>
            (error as { code?: string }).code ===
            "control.clientIdentityRequired",
    );
    await negotiate(socketConnection, "tui");
    await negotiate(webConnection, "web");

    assert.deepEqual(
        await socketConnection.request<JsonValue>(
            "@control",
            "server",
            "ping",
        ),
        {
            pong: true,
            protocolVersion: CONTROL_PROTOCOL_VERSION,
            subject: { id: "uid:1000", kind: "local-owner" },
        },
    );
    assert.deepEqual(
        await webConnection.request<JsonValue>("@control", "server", "ping"),
        {
            pong: true,
            protocolVersion: CONTROL_PROTOCOL_VERSION,
            subject: { id: "session:abc", kind: "web-session" },
        },
    );
    await assert.rejects(
        webConnection.request("@control", "server", "hello", {
            clientKind: "web",
            protocolRange: CONTROL_PROTOCOL_RANGE,
        }),
        (error: unknown) =>
            (error as { code?: string }).code ===
            "control.clientIdentityInvalid",
    );

    await server.close();
    assert.equal(socketProvider.closed, true);
    assert.equal(webProvider.closed, true);
    assert.equal(closedConnections.length, 2);
    await assert.rejects(
        webConnection.request("@control", "server", "ping"),
        /closed/iu,
    );
});

test("ControlTransportServer keeps sessions independent when Channels reuse a Host", async (t) => {
    const local = new MemoryControlTransportListener({
        allowedPeers: ["tui"],
        subject: { id: "local", kind: "local-owner" },
    });
    const web = new MemoryControlTransportListener({
        allowedPeers: ["web"],
        subject: { id: "web", kind: "web-session" },
    });
    const closed: string[] = [];
    const server = new ControlTransportServer({
        listeners: [local, web],
        onConnectionDetached: (connectionId) => closed.push(connectionId),
        routes: createRouteProvider(createSessionRouteHosts),
    });
    await server.start();
    t.after(async () => await server.close());
    const first = createClient(local, "tui", "shared-host");
    const second = createClient(web, "web", "shared-host");
    t.after(() => first.close());
    t.after(() => second.close());

    await negotiate(first, "tui");
    await negotiate(second, "web");
    const firstIdentity = await first.request<SessionIdentity>("@control", "session", "identify");
    const secondIdentity = await second.request<SessionIdentity>("@control", "session", "identify");
    assert.equal(firstIdentity.sourceHost, "shared-host");
    assert.equal(secondIdentity.sourceHost, "shared-host");
    assert.notEqual(firstIdentity.connectionId, secondIdentity.connectionId);
    assert.equal(firstIdentity.peer, "tui");
    assert.equal(secondIdentity.peer, "web");
    assert.equal(firstIdentity.subject, "local");
    assert.equal(secondIdentity.subject, "web");

    const firstStream = await first.open("@control", "session", "identify");
    assert.deepEqual(await firstStream.readMessage(), {
        type: "close",
        message: firstIdentity,
    });
    const secondStream = await second.open("@control", "session", "identify");
    assert.deepEqual(await secondStream.readMessage(), {
        type: "close",
        message: secondIdentity,
    });

    first.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(closed, [firstIdentity.connectionId]);
    assert.deepEqual(
        await second.request("@control", "session", "identify"),
        secondIdentity,
    );
    second.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(closed, [firstIdentity.connectionId, secondIdentity.connectionId]);
});

test("ControlTransportServer keeps separate Host sessions on the same Channel", async (t) => {
    const provider = new MemoryControlTransportListener();
    const closed: string[] = [];
    const server = new ControlTransportServer({
        listeners: [provider],
        onConnectionDetached: (connectionId) => closed.push(connectionId),
        routes: createRouteProvider(createSessionRouteHosts),
    });
    await server.start();
    t.after(async () => await server.close());
    const client = createClient(provider, "tui", "host-one");
    t.after(() => client.close());
    await negotiate(client, "tui");
    const first = await client.request<SessionIdentity>("@control", "session", "identify");
    const secondRpc = new Rpc(
        client.endpoint.bind("server", "host-two").connect("@control", "server"),
    );
    t.after(() => secondRpc.close());
    await secondRpc.request("hello", {
        clientKind: "tui",
        protocolRange: CONTROL_PROTOCOL_RANGE,
    });
    const secondPort = client.endpoint.bind("session", "host-two");
    const secondConnection = new Rpc(secondPort.connect("@control", "session"));
    t.after(() => secondConnection.close());
    const second = await secondConnection.request<SessionIdentity>("identify");
    assert.equal(first.sourceHost, "host-one");
    assert.equal(second.sourceHost, "host-two");
    assert.notEqual(first.connectionId, second.connectionId);
    const secondStream = new Stream(secondPort.connect("@control", "session"));
    t.after(() => secondStream.close());
    assert.deepEqual(await (await secondStream.open("identify")).readMessage(), {
        type: "close",
        message: second,
    });
    client.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(new Set(closed), new Set([first.connectionId, second.connectionId]));
});

test("ControlTransportServer rejects a self-asserted peer outside transport admission", async (t) => {
    const provider = new MemoryControlTransportListener({
        allowedPeers: ["web"],
        subject: { id: "session:abc", kind: "web-session" },
    });
    const server = new ControlTransportServer({
        listeners: [provider],
        routes: createRouteProvider(),
    });
    await server.start();
    t.after(async () => await server.close());
    const connection = createClient(provider, "tui");
    t.after(() => connection.close());

    await assert.rejects(
        negotiate(connection, "tui"),
        (error: unknown) =>
            (error as { code?: string }).code ===
            "control.clientIdentityInvalid",
    );
});

test("ControlTransportServer rejects unsupported protocol ranges during first request", async (t) => {
    const provider = new MemoryControlTransportListener();
    const server = new ControlTransportServer({
        listeners: [provider],
        routes: createRouteProvider(),
    });
    await server.start();
    t.after(async () => await server.close());
    const connection = createClient(provider, "tui");
    t.after(() => connection.close());

    await assert.rejects(
        connection.request("@control", "server", "hello", {
            clientKind: "tui",
            protocolRange: { max: "2.0.0", min: "2.0.0" },
        }),
        (error: unknown) =>
            (error as { code?: string }).code === "protocol.versionUnsupported",
    );
});

test("ControlTransportServer rejects unsafe semantic protocol components as invalid hello", async (t) => {
    const provider = new MemoryControlTransportListener();
    const server = new ControlTransportServer({
        listeners: [provider],
        routes: createRouteProvider(),
    });
    await server.start();
    t.after(async () => await server.close());
    const connection = createClient(provider, "tui");
    t.after(() => connection.close());

    await assert.rejects(
        connection.request("@control", "server", "hello", {
            clientKind: "tui",
            protocolRange: {
                max: "9007199254740992.0.0",
                min: "9007199254740993.0.0",
            },
        }),
        (error: unknown) =>
            (error as { code?: string }).code ===
            controlErrorCodes.invalidTarget,
    );
});

test("ControlTransportServer negotiates semantic protocol ranges", async (t) => {
    const provider = new MemoryControlTransportListener();
    const server = new ControlTransportServer({
        listeners: [provider],
        routes: createRouteProvider(),
    });
    await server.start();
    t.after(async () => await server.close());
    const connection = createClient(provider, "tui");
    t.after(() => connection.close());

    assert.deepEqual(
        await connection.request("@control", "server", "hello", {
            clientKind: "tui",
            protocolRange: CONTROL_PROTOCOL_RANGE,
        }),
        {
            capabilities: ["request", "stream", "streamResume"],
            protocolVersion: CONTROL_PROTOCOL_VERSION,
        },
    );
});

test("ControlTransportServer does not authenticate a connection when hello handling fails", async (t) => {
    const provider = new MemoryControlTransportListener();
    const server = new ControlTransportServer({
        listeners: [provider],
        routes: createRouteProvider(() => [
            {
                host: "@control",
                ports: [
                    {
                        name: "server",
                        operations: [
                            {
                                name: "hello",
                                handle: () => {
                                    throw new Error("hello failed");
                                },
                            },
                            {
                                name: "ping",
                                handle: () => ({ pong: true }),
                            },
                        ],
                    },
                ],
            },
        ]),
    });
    await server.start();
    t.after(async () => await server.close());
    const connection = createClient(provider, "tui");
    t.after(() => connection.close());

    await assert.rejects(negotiate(connection, "tui"), /hello failed/u);
    await assert.rejects(
        connection.request("@control", "server", "ping"),
        (error: unknown) =>
            (error as { code?: string }).code ===
            "control.clientIdentityRequired",
    );
});

test("ControlTransportServer closes earlier providers when a later provider fails to start", async () => {
    const first = new MemoryControlTransportListener();
    const failure: ControlTransportListener = {
        async start() {
            throw new Error("provider failed to start");
        },
        async close() {
            throw new Error("provider that did not start must not be closed");
        },
    };
    const server = new ControlTransportServer({
        listeners: [first, failure],
        routes: {
            hosts: createRouteHosts,
            onChange: () => () => undefined,
        },
    });

    await assert.rejects(server.start(), /provider failed to start/iu);
    assert.equal(first.closed, true);
});

test("ControlTransportServer coalesces concurrent start calls", async (t) => {
    const provider = new BlockingControlTransportListener();
    const server = new ControlTransportServer({
        listeners: [provider],
        routes: {
            hosts: createRouteHosts,
            onChange: () => () => undefined,
        },
    });
    t.after(async () => await server.close());

    const first = server.start();
    await provider.started;
    const second = server.start();
    await new Promise((resolve) => setTimeout(resolve));

    assert.equal(provider.startCount, 1);
    provider.releaseStart();
    await Promise.all([first, second]);
    assert.equal(provider.startCount, 1);
});

test("ControlTransportServer waits for an active start before closing providers", async () => {
    const provider = new BlockingControlTransportListener();
    const server = new ControlTransportServer({
        listeners: [provider],
        routes: {
            hosts: createRouteHosts,
            onChange: () => () => undefined,
        },
    });

    const start = server.start();
    await provider.started;
    const close = server.close();
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal(provider.closeCount, 0);

    provider.releaseStart();
    await Promise.all([start, close]);
    assert.equal(provider.startCount, 1);
    assert.equal(provider.closeCount, 1);
});

test("ControlTransportServer retries providers that failed to close", async () => {
    const provider = new RetryCloseControlTransportListener(1);
    const server = new ControlTransportServer({
        listeners: [provider],
        routes: {
            hosts: createRouteHosts,
            onChange: () => () => undefined,
        },
    });

    await server.start();
    await assert.rejects(server.close(), /listeners failed to close/iu);
    assert.equal(provider.closeCount, 1);

    await server.close();
    assert.equal(provider.closeCount, 2);
});

test("ControlTransportServer finishes failed cleanup before restarting providers", async () => {
    const provider = new RetryCloseControlTransportListener(1);
    const server = new ControlTransportServer({
        listeners: [provider],
        routes: {
            hosts: createRouteHosts,
            onChange: () => () => undefined,
        },
    });

    await server.start();
    await assert.rejects(server.close(), /listeners failed to close/iu);
    await server.start();

    assert.deepEqual(provider.events, [
        "start:1",
        "close:1",
        "close:2",
        "start:2",
    ]);
    await server.close();
});

test("ControlTransportServer coalesces restarts while failed cleanup is retried", async () => {
    const provider = new BlockingRetryCloseControlTransportListener();
    const server = new ControlTransportServer({
        listeners: [provider],
        routes: {
            hosts: createRouteHosts,
            onChange: () => () => undefined,
        },
    });

    await server.start();
    await assert.rejects(server.close(), /listeners failed to close/iu);
    const first = server.start();
    await provider.cleanupStarted;
    const second = server.start();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(provider.startCount, 1);
    assert.equal(provider.closeCount, 2);
    provider.releaseCleanup();
    await Promise.all([first, second]);

    assert.deepEqual(provider.events, [
        "start:1",
        "close:1",
        "close:2",
        "start:2",
    ]);
    await server.close();
});

test("ControlTransportServer replaces one started provider without closing others", async () => {
    const socket = new MemoryControlTransportListener();
    const web = new MemoryControlTransportListener();
    const replacement = new MemoryControlTransportListener();
    const server = new ControlTransportServer({
        listeners: [socket, web],
        routes: createRouteProvider(),
    });

    await server.start();
    await server.replaceListener(web, replacement);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(socket.closed, false);
    assert.equal(web.closed, true);
    assert.equal(replacement.started, true);
    await server.close();
});

test("ControlTransportServer rolls back a replacement when the previous provider fails to close", async () => {
    const socket = new MemoryControlTransportListener();
    const previous = new RetryCloseControlTransportListener(1);
    const replacement = new RetryCloseControlTransportListener(0);
    const server = new ControlTransportServer({
        listeners: [socket, previous],
        routes: createRouteProvider(),
    });

    await server.start();
    await assert.rejects(
        server.replaceListener(previous, replacement),
        /provider close failed/iu,
    );

    assert.deepEqual(previous.events, ["start:1", "close:1", "start:2"]);
    assert.deepEqual(replacement.events, ["start:1", "close:1"]);
    assert.equal(socket.closed, false);

    await server.close();
    assert.deepEqual(previous.events, [
        "start:1",
        "close:1",
        "start:2",
        "close:2",
    ]);
    assert.deepEqual(replacement.events, ["start:1", "close:1"]);
});

test("ControlTransportServer refreshes RPC and stream routes without terminating active calls", async (t) => {
    const provider = new MemoryControlTransportListener();
    const listeners = new Set<() => void>();
    let generation = 1;
    let startedCall!: () => void;
    let startedStream!: () => void;
    let finishCall!: () => void;
    let finishStream!: () => void;
    const callStarted = new Promise<void>((resolve) => { startedCall = resolve; });
    const streamStarted = new Promise<void>((resolve) => { startedStream = resolve; });
    const callFinished = new Promise<void>((resolve) => { finishCall = resolve; });
    const streamFinished = new Promise<void>((resolve) => { finishStream = resolve; });
    const routes = {
        hosts: (): readonly ControlHostDefinition[] => [
            ...createRouteHosts(),
            {
                host: "@control",
                ports: [{
                    name: "dynamic",
                    operations: [
                        {
                            name: "version",
                            handle: generation === 1
                                ? async () => {
                                      startedCall();
                                      await callFinished;
                                      return { generation: 1 };
                                  }
                                : () => ({ generation: 2 }),
                        },
                        ...(generation === 1
                            ? [{ name: "removed", handle: () => ({ removed: true }) }]
                            : [{ name: "added", handle: () => ({ added: true }) }]),
                    ],
                    streams: [{
                        name: "watch",
                        handle: generation === 1
                            ? async (stream: MessageStream) => {
                                  startedStream();
                                  await streamFinished;
                                  await stream.close({ generation: 1 });
                              }
                            : async (stream: MessageStream) => {
                                  await stream.close({ generation: 2 });
                              },
                    }],
                }],
            },
        ],
        onChange(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    const server = new ControlTransportServer({ listeners: [provider], routes });
    await server.start();
    t.after(async () => await server.close());
    const client = createClient(provider, "tui");
    t.after(() => client.close());
    await negotiate(client, "tui");

    const first = client.request("@control", "dynamic", "version");
    await callStarted;
    const firstWatch = await client.open("@control", "dynamic", "watch");
    await streamStarted;
    generation = 2;
    for (const listener of listeners) listener();

    assert.deepEqual(await client.request("@control", "dynamic", "version"), { generation: 2 });
    assert.deepEqual(await client.request("@control", "dynamic", "added"), { added: true });
    await assert.rejects(client.request("@control", "dynamic", "removed"), /not found/iu);
    const secondWatch = await client.open("@control", "dynamic", "watch");
    assert.deepEqual(await secondWatch.readMessage(), {
        type: "close",
        message: { generation: 2 },
    });

    finishCall();
    finishStream();
    assert.deepEqual(await first, { generation: 1 });
    assert.deepEqual(await firstWatch.readMessage(), {
        type: "close",
        message: { generation: 1 },
    });
});

test("rewritten ToolCall reaches the destination host through its tool route", async (t) => {
    const provider = new MemoryControlTransportListener();
    const targetCalls: string[] = [];
    const server = new ControlTransportServer({
        listeners: [provider],
        routes: createRouteProvider(() => [
            ...createRouteHosts(),
            {
                host: "destination",
                ports: [createToolRouteModule({
                    name: "destination",
                    worker: {
                        readWorkerTools: async () => [],
                        prepareWorkspace: async (workspace) => ({ workspace }),
                        readToolCalls: async () => [],
                        readToolCallFailureSummary: async () => ({ count: 0 }),
                        releaseToolSession: async () => undefined,
                        dispatchToolCall: async (request) => {
                            targetCalls.push(request.value.context.instance);
                            const result = await request.execute!(
                                request.callId,
                                request.value.payload,
                                request.value,
                            );
                            const value = await request.hooks.rewrite({
                                callId: request.callId,
                                direction: "outbound",
                                value: {
                                    ...request.value,
                                    kind: "result",
                                    payload: result as JsonValue,
                                },
                            });
                            const review = await request.hooks.review({
                                callId: request.callId,
                                direction: "outbound",
                                value,
                            });
                            assert.equal(review.decision, "continue");
                            return value.payload;
                        },
                    },
                })],
            },
        ]),
    });
    await server.start();
    t.after(async () => await server.close());
    const client = createClient(provider, "tui");
    t.after(() => client.close());
    await negotiate(client, "tui");

    const source = createToolCallRuntime({
        resolveTarget: (instance) => createToolCallTargetTransport(client.endpoint, instance),
    });
    source.hooks.registerContributor(() => ({
        rewrites: [{
            hook: "route",
            id: "redirect",
            rewrite: (input) => input.direction === "inbound"
                ? {
                      ...input.value,
                      context: { ...input.value.context, instance: asInstanceName("destination") },
                      toolName: "virtual_execute",
                  }
                : input.value,
        }],
        release() {},
    }));
    source.hooks.registerExecute("virtual_execute", async (_callId, input) => ({ input }));
    const result = await source.api.call(
        "source",
        "original_tool",
        { value: 7 },
        { source: "tui" },
    );
    assert.deepEqual(result, { input: { value: 7 } });
    assert.deepEqual(targetCalls, ["destination"]);
    source.close();
});

interface TestClient {
    endpoint: Endpoint;
    close(): void;
    open(host: string, port: string, method: string): Promise<MessageStream>;
    request<T = JsonValue>(
        host: string,
        port: string,
        method: string,
        payload?: JsonValue,
    ): Promise<T>;
}

function createClient(
    provider: MemoryControlTransportListener,
    _peer: "cli" | "tui" | "web",
    host?: string,
): TestClient {
    const endpoint = new Endpoint({
        ...(host === undefined ? {} : { host }),
        connectChannel: async () => provider.connect(),
    });
    const rpcs = new Map<string, Rpc>();
    const streams = new Map<string, Stream>();
    return {
        endpoint,
        close() {
            for (const rpc of rpcs.values()) rpc.close();
            for (const stream of streams.values()) stream.close();
            endpoint.close();
        },
        async open(host: string, port: string, method: string): Promise<MessageStream> {
            const key = `${host}\u0000${port}`;
            let stream = streams.get(key);
            if (stream === undefined) {
                stream = new Stream(await endpoint.connect(host, port));
                streams.set(key, stream);
            }
            return await stream.open(method);
        },
        async request<T = JsonValue>(
            host: string,
            port: string,
            method: string,
            payload?: JsonValue,
        ): Promise<T> {
            const key = `${host}\u0000${port}`;
            let rpc = rpcs.get(key);
            if (rpc === undefined) {
                rpc = new Rpc(await endpoint.connect(host, port));
                rpcs.set(key, rpc);
            }
            return (await rpc.request(method, payload)) as T;
        },
    };
}

function createRouteProvider(
    hosts: () => readonly ControlHostDefinition[] = createRouteHosts,
) {
    return {
        hosts,
        onChange: () => () => undefined,
    };
}

function createRouteHosts(): readonly ControlHostDefinition[] {
    return [
        {
            host: "@control",
            ports: [
                {
                    name: "server",
                    operations: [
                        {
                            name: "hello",
                            handle: (request, context) =>
                                negotiateControlProtocol(
                                    request.payload,
                                    context.peer,
                                ) as unknown as JsonValue,
                        },
                        {
                            name: "ping",
                            handle: (_request, context) => ({
                                pong: true,
                                ...(context.protocolVersion === undefined
                                    ? {}
                                    : {
                                          protocolVersion:
                                              context.protocolVersion,
                                      }),
                                ...(context.subject === undefined
                                    ? {}
                                    : {
                                          subject: {
                                              id: context.subject.id,
                                              kind: context.subject.kind,
                                          },
                                      }),
                            }),
                        },
                    ],
                },
            ],
        },
    ];
}

interface SessionIdentity {
    readonly connectionId: string;
    readonly peer: string;
    readonly sourceHost: string;
    readonly subject: string | null;
}

function createSessionRouteHosts(): readonly ControlHostDefinition[] {
    const identify = (context: ControlPortContext) => ({
        connectionId: context.connectionId,
        peer: context.peer,
        sourceHost: context.sourceHost,
        subject: context.subject?.id ?? null,
    });
    return [...createRouteHosts(), {
        host: "@control",
        ports: [{
            name: "session",
            operations: [{ name: "identify", handle: (_request, context) => identify(context) }],
            streams: [{
                name: "identify",
                handle: async (stream, _request, context) =>
                    await stream.close(identify(context)),
            }],
        }],
    }];
}

async function negotiate(
    connection: TestClient,
    clientKind: "cli" | "tui" | "web",
): Promise<void> {
    await connection.request("@control", "server", "hello", {
        clientKind,
        protocolRange: CONTROL_PROTOCOL_RANGE,
    });
}


// Actual Packet/RPC/Stream wire and Gateway admission, real ToolCall pipeline,
// scheduler, Approval and SQLite Audit. Tests supply the Worker leaf executors.
async function ingressHarness(t: test.TestContext) {
    const alpha = await round4Target({}, "alpha");
    const beta = await round4Target({}, "beta");
    const provider = new MemoryControlTransportListener();
    const client = createClient(provider, "cli");
    const ingress = createToolCallRuntime({
        resolveTarget: (instance) => createToolCallTargetTransport(client.endpoint, instance),
    });
    const server = new ControlTransportServer({
        listeners: [provider],
        routes: createRouteProvider(() => [
            ...createRouteHosts(),
            ...[alpha, beta].map((h) => ({
                host: h.instanceName,
                ports: [mergeControlPorts(createToolRouteModule({
                    name: h.instanceName,
                    worker: {
                        readWorkerTools: async () => [],
                        prepareWorkspace: async (workspace) => ({ workspace }),
                        readToolCalls: async (query) => h.audit.api.toolCalls.readQuery(query),
                        readToolCallFailureSummary: async () => ({ count: 0 }),
                        releaseToolSession: async () => {},
                        dispatchToolCall: (request) => h.tool.target().dispatch(request),
                    },
                }), createToolCallIngressTransportRoute(ingress.api, client.endpoint.host))],
            })),
        ]),
    });
    t.after(async () => {
        client.close();
        await server.close();
        ingress.close();
        await Promise.all([alpha.close(), beta.close()]);
    });
    await server.start();
    await client.request("@control", "server", "hello", { clientKind: "cli", protocolRange: CONTROL_PROTOCOL_RANGE });
    return { alpha, beta, provider, client, ingress, calls: createToolCallIngressTransport(client.endpoint) };
}

for (const decision of ["approve", "deny"] as const) {
    test(`Control ingress MCP ${decision} preserves adapters, Context and destination Audit`, { timeout: 10_000 }, async (t) => {
        const h = await ingressHarness(t);
        const approval = barrier<string>();
        registerApprovalToolCallReview(h.ingress.hooks, {
            async evaluate(input, signal) {
                const evaluated = await h.alpha.approval.evaluate(input, signal);
                assert.equal(evaluated.decision, "ask");
                if (evaluated.decision === "ask") approval.resolve(evaluated.request.approvalId);
                return evaluated;
            },
        });
        const seen: Array<{ context: unknown; recording: string }> = [];
        let released = 0;
        h.ingress.hooks.registerContributor((context, runtime) => {
            seen.push({ context, recording: runtime.recording });
            return {
                rewrites: [{ hook: "600-route", id: "beta", rewrite: (input) => ({
                    ...input.value,
                    context: { ...input.value.context, instance: asInstanceName("beta"), workspace: "/beta" },
                }) }],
                release() { released++; },
            };
        });
        let executions = 0;
        h.ingress.hooks.registerExecute("file_read", async (_id, input) => {
            executions++;
            return { type: "presented-tool-call-result", result: input,
                presentation: { content: [{ type: "text", text: "Transport presentation" }] } };
        });
        const source = new TestToolSource();
        source.register("alpha", [{ name: "file_read", description: "Read", group: "file", inputSchema: { type: "object" }, outputSchema: { type: "object" }, requiredCapabilities: [] }]);
        const resolved: Array<{ instance?: string; touch?: boolean }> = [];
        const dispatch = new McpEndpointDispatch({
            instanceName: "alpha", catalog: new McpEndpointCatalog({ instanceName: "alpha", source }),
            context: { async resolve(input) {
                assert.equal(input.ctxId, "ctx-mcp");
                assert.equal(input.principal, "principal-mcp");
                resolved.push(input);
                return { ctxId: "ctx-mcp", environments: [{ instance: "alpha", workspace: "/alpha" }, { instance: "beta", workspace: "/beta" }], status: "active", principal: "principal-mcp", createdAt: "now", expiresAt: "later", lastAccessedAt: "now" };
            } },
            tools: h.calls,
        });
        let executedId = "";
        const pending = dispatch.callTool("file_read", { ctxId: "ctx-mcp", path: "a" }, {
            principal: "principal-mcp", requestId: "mcp-request",
        }, undefined, (callId, value, result) => {
            executedId = callId;
            assert.equal(value.context.instance, "beta");
            assert.deepEqual(result, { path: "a" });
        });
        const settled = Promise.allSettled([pending]);
        const id = await approval.promise;
        assert.equal(executions, 0, "Approval must precede execution and adapters");
        assert.equal(resolved.length, 1, "invocationInput waits for Approval");
        await h.alpha.approval.decideApproval(id, { decision, decidedBy: "cli" });
        const [result] = await settled;
        assert.equal(result!.status, decision === "approve" ? "fulfilled" : "rejected");
        const target = decision === "approve" ? h.beta : h.alpha;
        const records = await target.audit.api.toolCalls.readQuery();
        assert.equal(records.length, 1);
        assert.equal(records[0]!.source, "mcp");
        assert.equal(records[0]!.ctxId, "ctx-mcp");
        assert.equal(records[0]!.requestId, "mcp-request");
        assert.equal(records[0]!.status, decision === "approve" ? "completed" : "denied");
        assert.equal(executions, decision === "approve" ? 1 : 0);
        assert.equal(released, 1);
        assert.equal(seen[0]!.recording, "host");
        if (result!.status === "fulfilled") {
            assert.equal(executedId, records[0]!.callId);
            assert.equal(resolved.at(-1)!.instance, "beta");
            assert.equal(resolved.at(-1)!.touch, true);
            assert.deepEqual((result!.value as { content: unknown }).content, [{ type: "text", text: "Transport presentation" }]);
        }
    });
}

for (const recording of ["caller", "host"] as const) {
    test(`Control ingress preserves Extension attribution, ${recording} recording, progress and errors`, { timeout: 10_000 }, async (t) => {
        const h = await ingressHarness(t);
        const context: ToolCallContext = { source: "extension", extensionId: "agent", ctxId: "ctx-extension", workspace: "/alpha", operationId: "op", requestId: "request", principal: "principal", contextMode: "openai-session", externalBindings: [{ kind: "session", value: "binding" }] };
        const seen: unknown[] = [];
        h.ingress.hooks.registerContributor((value, runtime) => {
            assert.equal(runtime.recording, recording);
            seen.push(value);
            return { release() {} };
        });
        h.ingress.hooks.registerExecute("file_read", async (_id, input, _value, _signal, onProgress) => {
            onProgress?.({ step: "read" });
            return input;
        });
        h.ingress.hooks.registerContributor((value) => {
            if (value.operationId === "payload-failure")
                throw attachToolCallErrorPayload(createRemoteError({
                    code: "context.invalid", message: "invalid Context", retryable: false,
                }), { comment: ["Context validation failed"] });
            return { release() {} };
        });
        const progress: JsonValue[] = [];
        let adaptedId = "";
        assert.deepEqual(await h.calls.call("alpha", "file_read", { path: "file" }, context, undefined,
            async (result, callId) => { adaptedId = callId; return result; },
            (input) => input,
            (value) => progress.push(value), recording), { path: "file" });
        assert.deepEqual(seen, [{ ...context, instance: "alpha" }]);
        assert.deepEqual(progress, [{ step: "read" }]);
        const records = await h.alpha.audit.api.toolCalls.readQuery();
        assert.equal(records.length, recording === "host" ? 1 : 0);
        if (recording === "host") {
            assert.equal(records[0]!.extensionId, "agent");
            assert.equal(records[0]!.callId, adaptedId);
        }
        await assert.rejects(h.calls.call("alpha", "file_read", {}, { ...context, operationId: "payload-failure" }, undefined,
            undefined, undefined, undefined, recording), (error: unknown) => {
                assert.deepEqual(readToolCallErrorPayload(error), { comment: ["Context validation failed"] });
                return true;
            });
        await assert.rejects(h.calls.call("alpha", "file_read", {}, context, undefined, async () => {
            throw attachToolCallErrorPayload(createRemoteError({ code: "adapter.failed", message: "after execution", retryable: true }), { comment: ["adapter payload"] });
        }, undefined, undefined, recording), (error: unknown) => {
            const failure = error as { code: string; retryable: boolean; details: { executionCompleted: boolean; failureStage: string } };
            assert.equal(failure.code, "adapter.failed");
            assert.equal(failure.retryable, false);
            assert.equal(failure.details.executionCompleted, true);
            assert.equal(failure.details.failureStage, "postExecution");
            // ExecutionTarget deliberately removes private adapter payloads after execution.
            return true;
        });
    });
}

test("Control ingress rejects external and web identities before acquiring hooks", { timeout: 10_000 }, async (t) => {
    const h = await ingressHarness(t);
    let acquired = false;
    h.ingress.hooks.registerContributor(() => { acquired = true; return { release() {} }; });
    const external = createClient(h.provider, "cli");
    t.after(() => external.close());
    await external.request("@control", "server", "hello", { clientKind: "cli", protocolRange: CONTROL_PROTOCOL_RANGE });
    await assert.rejects(createToolCallIngressTransport(external.endpoint).call("alpha", "file_read", {}, { source: "mcp" }), /internal connection/u);
    assert.equal(acquired, false);
    // Same sourceHost with web-session admission must still be denied.
    const route = createToolCallIngressTransportRoute(h.ingress.api, h.client.endpoint.host);
    await assert.rejects(Promise.resolve(route.streams![0]!.handle({} as MessageStream, { id: "x", name: "ingress" }, {
        sourceHost: h.client.endpoint.host, peer: "cli", subject: { id: "web", kind: "web-session" },
    } as ControlPortContext)), /internal connection/u);
    assert.equal(acquired, false);
});

test("Control ingress cancellation reaches a pending Approval and releases hook leases", { timeout: 10_000 }, async (t) => {
    const h = await ingressHarness(t);
    const approval = barrier<string>();
    const released = barrier();
    h.ingress.hooks.registerContributor(() => ({ release() { released.resolve(); } }));
    registerApprovalToolCallReview(h.ingress.hooks, { async evaluate(input, signal) {
        const evaluated = await h.alpha.approval.evaluate(input, signal);
        if (evaluated.decision === "ask") approval.resolve(evaluated.request.approvalId);
        return evaluated;
    } });
    const controller = new AbortController();
    const pending = h.calls.call("alpha", "file_read", {}, { source: "mcp", ctxId: "cancel" }, controller.signal);
    const failed = assert.rejects(pending, /cancel/iu);
    const id = await approval.promise;
    controller.abort(new Error("cancel ingress"));
    await failed;
    await released.promise;
    assert.equal((await h.alpha.approval.getApproval(id)).status, "cancelled");
});


test("MCP Control module wires Transport without accessing an Instance ingress", { timeout: 10_000 }, async (t) => {
    const h = await ingressHarness(t);
    let tools!: ToolCallApi;
    const module = new McpControlModule({
        endpoint: h.client.endpoint, config: createDefaultControlConfig(), context: {} as never,
        controlPaths: new ControlPathHome(h.alpha.directory), http: new ControlHttpServer(),
        instances: { get() { throw new Error("Control must not access Instance ingress"); } } as never,
        toolRegistry: createToolCallRegistry(),
        factory: { wire(_config: unknown, _instances: unknown, options: { runtimeState: { tools: ToolCallApi } }) {
            tools = options.runtimeState.tools;
            return undefined;
        } } as never,
    });
    t.after(() => module.stop());
    h.ingress.hooks.registerExecute("file_read", async (_id, input) => input);
    assert.deepEqual(await tools.call("beta", "file_read", { path: "module" }, { source: "mcp", ctxId: "module-context" }), { path: "module" });
    const [record] = await h.beta.audit.api.toolCalls.readQuery();
    assert.equal(record!.ctxId, "module-context"); assert.equal(record!.source, "mcp");
});

for (const destination of ["alpha", "beta"] as const) {
    test(`ToolCall cancellation drains execution on ${destination} before returning terminal`, { timeout: 10_000 }, async (t) => {
        const h = await ingressHarness(t);
        const entered = barrier();
        const finish = barrier();
        t.after(() => finish.resolve());
        const events: string[] = [];
        h.ingress.hooks.registerContributor(() => ({
            rewrites: [{ hook: "600-route", id: destination, rewrite: (input) => ({
                ...input.value, context: { ...input.value.context, instance: asInstanceName(destination) },
            }) }], release() {},
        }));
        h.ingress.hooks.registerExecute("file_read", async (_id, _input, _value, signal) => {
            entered.resolve();
            await finish.promise;
            events.push("effect-done");
            signal?.throwIfAborted();
            return {};
        });
        const controller = new AbortController();
        let settled = false;
        const pending = h.calls.call("alpha", "file_read", {}, {
            source: "extension", extensionId: "draining.agent", workspace: "/alpha",
        }, controller.signal);
        void pending.then(() => { settled = true; }, () => { settled = true; });
        const rejected = assert.rejects(pending, { code: runtimeErrorCodes.toolCallCancelled });
        await entered.promise;
        controller.abort(new Error("cancel after effect"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(settled, false, "terminal acknowledgement must wait for execution to drain");
        finish.resolve();
        await rejected;
        events.push("terminal");
        assert.deepEqual(events, ["effect-done", "terminal"]);
        const [record] = await h[destination].audit.api.toolCalls.readQuery();
        assert.equal(record!.status, "cancelled");
        assert.equal(record!.extensionId, "draining.agent");
    });
}

test("Instance host registers ingress inside its generation admission fence", { timeout: 10_000 }, async (t) => {
    const started = barrier();
    const finish = barrier();
    t.after(() => finish.resolve());
    const instance = createTestInstanceDescriptor({
        snapshot: () => ({ lastSeq: 0, ready: true, name: "alpha" }),
        subscribe: () => ({ kind: "events", events: [], lastSeq: 0 }),
        async callTool() { started.resolve(); await finish.promise; return { done: true }; },
    } as never);
    const provider = new MemoryControlTransportListener();
    const client = createClient(provider, "cli");
    const server = new ControlTransportServer({
        listeners: [provider], routes: createRouteProvider(() => [
            ...createRouteHosts(), instance.host([], undefined, client.endpoint.host),
        ]),
    });
    t.after(async () => { client.close(); await server.close(); });
    await server.start();
    await client.request("@control", "server", "hello", { clientKind: "cli", protocolRange: CONTROL_PROTOCOL_RANGE });
    const calls = createToolCallIngressTransport(client.endpoint);
    const pending = calls.call("alpha", "file_read", {}, { source: "mcp" });
    await started.promise;
    instance.lifecycle.beginRetirement();
    let drained = false;
    const draining = instance.lifecycle.drain().then(() => { drained = true; });
    await assert.rejects(calls.call("alpha", "file_read", {}, { source: "mcp" }), /retired/u);
    assert.equal(drained, false);
    finish.resolve();
    assert.deepEqual(await pending, { done: true });
    await draining;
    assert.equal(drained, true);
});


test("Control ingress preserves Context and owner fences of the MCP Reentry claim executor", { timeout: 10_000 }, async (t) => {
    const h = await ingressHarness(t);
    const goal = new GoalService({
        appendEvent: async () => {}, filePath: join(h.alpha.directory, "goals.json"), instanceName: "alpha",
    });
    const created = await goal.manage("claim-context", { action: "start", workspace: "/alpha", objective: "Resume" });
    assert.ok(created);
    const stop = installMcpAppReentry(h.ingress.hooks, { goal } as never);
    t.after(stop);
    const base = { claimId: "owner", sourceId: created.goalId, intent: "goal-resume" };
    const call = (input: Record<string, JsonValue>, context: ToolCallContext = { source: "mcp", ctxId: "claim-context", workspace: "/alpha" }) =>
        h.calls.call("alpha", "mcpapp_reentry", { ...base, ...input }, context);
    await assert.rejects(call({ action: "claim" }, { source: "extension", ctxId: "claim-context", workspace: "/alpha" }), /validated Context/u);
    await assert.rejects(call({ action: "claim" }, { source: "mcp", ctxId: "other-context", workspace: "/alpha" }), /Context and Workspace/u);
    assert.equal((await call({ action: "claim" }) as { claimed: boolean }).claimed, true);
    assert.equal((await call({ action: "validate", claimId: "wrong-owner" }) as { valid: boolean }).valid, false);
    await assert.rejects(call({ action: "attempt", claimId: "wrong-owner" }), /no longer active/u);
    assert.equal((await call({ action: "attempt" }) as { attempted: boolean }).attempted, true);
    assert.deepEqual(await call({ action: "attempt" }), { attempted: false, duplicate: true });
    await assert.rejects(call({ action: "report", outcome: "accepted", claimId: "wrong-owner" }), /no longer active/u);
    await call({ action: "report", outcome: "accepted" });
    assert.equal((await goal.read("claim-context"))!.continuationPending, false);
    assert.equal((await goal.read("claim-context"))!.continuationCount, 1);
});
