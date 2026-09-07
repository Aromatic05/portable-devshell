import assert from "node:assert/strict";
import test from "node:test";

import {
    CONTROL_PROTOCOL_VERSION,
    ClientConnection,
    PrefixRoute,
    createError,
    type Channel,
    type JsonValue,
    type PrefixRouteSnapshot
} from "@portable-devshell/shared";

import {
    ControlChannelServer,
    type ControlAcceptedChannel,
    type ControlChannelAdmission,
    type ControlChannelListener
} from "../../src/server/channel/ControlChannelServer.ts";
import { negotiateControlProtocol } from "../../src/control/service/ServiceRouteModule.ts";

class MemoryChannel implements Channel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #frameListeners = new Set<(frame: Uint8Array) => void>();
    #closeError?: Error;
    #closed = false;
    #peer?: MemoryChannel;

    get closed(): boolean {
        return this.#closed;
    }

    bind(peer: MemoryChannel): void {
        this.#peer = peer;
    }

    async send(frame: Uint8Array): Promise<void> {
        if (this.#closed) {
            throw this.#closeError ?? new Error("Memory channel is closed.");
        }
        const peer = this.#peer;
        if (peer === undefined) {
            throw new Error("Memory channel peer is not bound.");
        }
        if (peer.#closed) {
            throw peer.#closeError ?? new Error("Memory channel peer is closed.");
        }
        const copy = Uint8Array.from(frame);
        queueMicrotask(() => peer.#accept(copy));
    }

    onFrame(listener: (frame: Uint8Array) => void): () => void {
        this.#frameListeners.add(listener);
        return () => this.#frameListeners.delete(listener);
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

    #accept(frame: Uint8Array): void {
        if (this.#closed) {
            return;
        }
        for (const listener of [...this.#frameListeners]) {
            listener(frame);
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

class MemoryControlChannelListener implements ControlChannelListener {
    readonly #admission: ControlChannelAdmission;
    #accept?: (connection: ControlAcceptedChannel) => void;
    closed = false;
    started = false;

    constructor(admission: ControlChannelAdmission = {
        allowedPeers: ["cli", "tui"],
        subject: { id: "uid:test", kind: "local-owner" },
    }) {
        this.#admission = admission;
    }

    async start(accept: (connection: ControlAcceptedChannel) => void): Promise<void> {
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

class BlockingControlChannelListener implements ControlChannelListener {
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

class RetryCloseControlChannelListener implements ControlChannelListener {
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

class BlockingRetryCloseControlChannelListener implements ControlChannelListener {
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


test("ControlChannelServer serves the same routes through multiple channel providers", async (t) => {
    const socketProvider = new MemoryControlChannelListener({
        allowedPeers: ["cli", "tui"],
        subject: { id: "uid:1000", kind: "local-owner" },
    });
    const webProvider = new MemoryControlChannelListener({
        allowedPeers: ["web"],
        subject: { id: "session:abc", kind: "web-session" },
    });
    const closedConnections: string[] = [];
    const routes = {
        connectionClosed(connectionId: string) {
            closedConnections.push(connectionId);
        },
        snapshot: createRouteSnapshot
    };
    const server = new ControlChannelServer({
        listeners: [socketProvider, webProvider],
        routes
    });
    await server.start();
    t.after(async () => await server.close());

    const socketConnection = createClient(socketProvider, "tui");
    const webConnection = createClient(webProvider, "web");
    t.after(() => socketConnection.close());
    t.after(() => webConnection.close());

    await assert.rejects(
        socketConnection.request("@control", "service", "ping"),
        (error: unknown) =>
            (error as { code?: string }).code === "control.clientIdentityRequired",
    );
    await negotiate(socketConnection, "tui");
    await negotiate(webConnection, "web");

    assert.deepEqual(
        await socketConnection.request<JsonValue>("@control", "service", "ping"),
        {
            pong: true,
            protocolVersion: CONTROL_PROTOCOL_VERSION,
            subject: { id: "uid:1000", kind: "local-owner" },
        }
    );
    assert.deepEqual(
        await webConnection.request<JsonValue>("@control", "service", "ping"),
        {
            pong: true,
            protocolVersion: CONTROL_PROTOCOL_VERSION,
            subject: { id: "session:abc", kind: "web-session" },
        }
    );
    await assert.rejects(
        webConnection.request("@control", "service", "hello", {
            clientKind: "web",
            maxProtocolVersion: CONTROL_PROTOCOL_VERSION,
            minProtocolVersion: CONTROL_PROTOCOL_VERSION,
        }),
        (error: unknown) =>
            (error as { code?: string }).code === "control.clientIdentityInvalid",
    );

    await server.close();
    assert.equal(socketProvider.closed, true);
    assert.equal(webProvider.closed, true);
    assert.equal(closedConnections.length, 2);
    await assert.rejects(
        webConnection.request("@control", "service", "ping"),
        /closed/iu
    );
});

test("ControlChannelServer rejects a self-asserted peer outside transport admission", async (t) => {
    const provider = new MemoryControlChannelListener({
        allowedPeers: ["web"],
        subject: { id: "session:abc", kind: "web-session" },
    });
    const server = new ControlChannelServer({
        listeners: [provider],
        routes: { connectionClosed() {}, snapshot: createRouteSnapshot },
    });
    await server.start();
    t.after(async () => await server.close());
    const connection = createClient(provider, "tui");
    t.after(() => connection.close());

    await assert.rejects(
        negotiate(connection, "tui"),
        (error: unknown) =>
            (error as { code?: string }).code === "control.clientIdentityInvalid",
    );
});

test("ControlChannelServer rejects unsupported protocol ranges during first request", async (t) => {
    const provider = new MemoryControlChannelListener();
    const server = new ControlChannelServer({
        listeners: [provider],
        routes: { connectionClosed() {}, snapshot: createRouteSnapshot },
    });
    await server.start();
    t.after(async () => await server.close());
    const connection = createClient(provider, "tui");
    t.after(() => connection.close());

    await assert.rejects(
        connection.request("@control", "service", "hello", {
            clientKind: "tui",
            maxProtocolVersion: CONTROL_PROTOCOL_VERSION + 1,
            minProtocolVersion: CONTROL_PROTOCOL_VERSION + 1,
        }),
        (error: unknown) =>
            (error as { code?: string }).code === "protocol.versionUnsupported",
    );
});

test("ControlChannelServer does not authenticate a connection when hello handling fails", async (t) => {
    const provider = new MemoryControlChannelListener();
    const server = new ControlChannelServer({
        listeners: [provider],
        routes: {
            connectionClosed() {},
            snapshot: () => PrefixRoute.snapshot([
                {
                    destination: "@control",
                    modules: [
                        {
                            name: "service",
                            operations: [
                                {
                                    name: "hello",
                                    handle: () => {
                                        throw new Error("hello failed");
                                    },
                                },
                                { name: "ping", handle: () => ({ pong: true }) },
                            ],
                        },
                    ],
                },
            ]),
        },
    });
    await server.start();
    t.after(async () => await server.close());
    const connection = createClient(provider, "tui");
    t.after(() => connection.close());

    await assert.rejects(negotiate(connection, "tui"), /hello failed/u);
    await assert.rejects(
        connection.request("@control", "service", "ping"),
        (error: unknown) =>
            (error as { code?: string }).code === "control.clientIdentityRequired",
    );
});

test("ControlChannelServer closes earlier providers when a later provider fails to start", async () => {
    const first = new MemoryControlChannelListener();
    const failure: ControlChannelListener = {
        async start() {
            throw new Error("provider failed to start");
        },
        async close() {
            throw new Error("provider that did not start must not be closed");
        }
    };
    const server = new ControlChannelServer({
        listeners: [first, failure],
        routes: {
            connectionClosed() {},
            snapshot: createRouteSnapshot
        }
    });

    await assert.rejects(server.start(), /provider failed to start/iu);
    assert.equal(first.closed, true);
});

test("ControlChannelServer coalesces concurrent start calls", async (t) => {
    const provider = new BlockingControlChannelListener();
    const server = new ControlChannelServer({
        listeners: [provider],
        routes: {
            connectionClosed() {},
            snapshot: createRouteSnapshot
        }
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

test("ControlChannelServer waits for an active start before closing providers", async () => {
    const provider = new BlockingControlChannelListener();
    const server = new ControlChannelServer({
        listeners: [provider],
        routes: {
            connectionClosed() {},
            snapshot: createRouteSnapshot
        }
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

test("ControlChannelServer retries providers that failed to close", async () => {
    const provider = new RetryCloseControlChannelListener(1);
    const server = new ControlChannelServer({
        listeners: [provider],
        routes: {
            connectionClosed() {},
            snapshot: createRouteSnapshot
        }
    });

    await server.start();
    await assert.rejects(server.close(), /listeners failed to close/iu);
    assert.equal(provider.closeCount, 1);

    await server.close();
    assert.equal(provider.closeCount, 2);
});

test("ControlChannelServer finishes failed cleanup before restarting providers", async () => {
    const provider = new RetryCloseControlChannelListener(1);
    const server = new ControlChannelServer({
        listeners: [provider],
        routes: {
            connectionClosed() {},
            snapshot: createRouteSnapshot
        }
    });

    await server.start();
    await assert.rejects(server.close(), /listeners failed to close/iu);
    await server.start();

    assert.deepEqual(provider.events, ["start:1", "close:1", "close:2", "start:2"]);
    await server.close();
});

test("ControlChannelServer coalesces restarts while failed cleanup is retried", async () => {
    const provider = new BlockingRetryCloseControlChannelListener();
    const server = new ControlChannelServer({
        listeners: [provider],
        routes: {
            connectionClosed() {},
            snapshot: createRouteSnapshot
        }
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

    assert.deepEqual(provider.events, ["start:1", "close:1", "close:2", "start:2"]);
    await server.close();
});

test("ControlChannelServer replaces one started provider without closing others", async () => {
    const socket = new MemoryControlChannelListener();
    const web = new MemoryControlChannelListener();
    const replacement = new MemoryControlChannelListener();
    const server = new ControlChannelServer({
        listeners: [socket, web],
        routes: { connectionClosed() {}, snapshot: createRouteSnapshot }
    });

    await server.start();
    await server.replaceListener(web, replacement);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(socket.closed, false);
    assert.equal(web.closed, true);
    assert.equal(replacement.started, true);
    await server.close();
});

test("ControlChannelServer rolls back a replacement when the previous provider fails to close", async () => {
    const socket = new MemoryControlChannelListener();
    const previous = new RetryCloseControlChannelListener(1);
    const replacement = new RetryCloseControlChannelListener(0);
    const server = new ControlChannelServer({
        listeners: [socket, previous],
        routes: { connectionClosed() {}, snapshot: createRouteSnapshot }
    });

    await server.start();
    await assert.rejects(
        server.replaceListener(previous, replacement),
        /provider close failed/iu
    );

    assert.deepEqual(previous.events, ["start:1", "close:1", "start:2"]);
    assert.deepEqual(replacement.events, ["start:1", "close:1"]);
    assert.equal(socket.closed, false);

    await server.close();
    assert.deepEqual(previous.events, ["start:1", "close:1", "start:2", "close:2"]);
    assert.deepEqual(replacement.events, ["start:1", "close:1"]);
});


function createClient(
    provider: MemoryControlChannelListener,
    peer: "tui" | "web"
): ClientConnection {
    return new ClientConnection({
        connectChannel: async () => provider.connect(),
        mapError: normalizeError,
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer
    });
}

function createRouteSnapshot(): PrefixRouteSnapshot {
    return PrefixRoute.snapshot([
        {
            destination: "@control",
            modules: [
                {
                    name: "service",
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
                                    : { protocolVersion: context.protocolVersion }),
                                ...(context.subject === undefined
                                    ? {}
                                    : {
                                          subject: {
                                              id: context.subject.id,
                                              kind: context.subject.kind,
                                          },
                                      }),
                            })
                        }
                    ]
                }
            ]
        }
    ]);
}

async function negotiate(
    connection: ClientConnection,
    clientKind: "cli" | "tui" | "web",
): Promise<void> {
    await connection.request("@control", "service", "hello", {
        clientKind,
        maxProtocolVersion: CONTROL_PROTOCOL_VERSION,
        minProtocolVersion: CONTROL_PROTOCOL_VERSION,
    });
}

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
