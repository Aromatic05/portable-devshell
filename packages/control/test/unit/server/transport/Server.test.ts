import assert from "node:assert/strict";
import test from "node:test";

import {
    CONTROL_PROTOCOL_RANGE,
    CONTROL_PROTOCOL_VERSION,
    Endpoint,
    Rpc,
    Stream,
    controlErrorCodes,
    type Channel,
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
    assert.deepEqual((await secondWatch.readMessage()).message, { generation: 2 });

    finishCall();
    finishStream();
    assert.deepEqual(await first, { generation: 1 });
    assert.deepEqual((await firstWatch.readMessage()).message, { generation: 1 });
});

interface TestClient {
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
    _peer: "tui" | "web",
): TestClient {
    const endpoint = new Endpoint({
        connectChannel: async () => provider.connect(),
    });
    const rpcs = new Map<string, Rpc>();
    const streams = new Map<string, Stream>();
    return {
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

async function negotiate(
    connection: TestClient,
    clientKind: "cli" | "tui" | "web",
): Promise<void> {
    await connection.request("@control", "server", "hello", {
        clientKind,
        protocolRange: CONTROL_PROTOCOL_RANGE,
    });
}
