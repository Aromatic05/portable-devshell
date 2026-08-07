import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { HttpHost } from "@portable-devshell/mcp";
import { McpHost } from "@portable-devshell/mcp/testing";
import {
    ClientConnection,
    CONTROL_PROTOCOL_VERSION,
    CONTROL_REMOTE_RPC_PATH,
    PrefixRoute,
    WebSocketChannel,
    controlWebBasePath,
    createError,
    type JsonValue,
    type PrefixRouteSnapshot
} from "@portable-devshell/shared";
import WebSocket from "ws";

import { ControlChannelServer } from "../../src/server/channel/ControlChannelServer.ts";
import { negotiateControlProtocol } from "../../src/control/service/ServiceRouteModule.ts";
import { ControlWebSessionService } from "../../src/server/web/ControlWebSessionService.ts";
import { ControlWebSocketAccessService } from "../../src/server/web/ControlWebSocketAccessService.ts";
import { ControlWebSocketListener } from "../../src/server/web/ControlWebSocketListener.ts";
import { NodeWebSocketChannel } from "../WebSocketTestSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const WEB_TOKEN = "portable-devshell-web-token-value";

test("web session cookie authenticates the shared control RPC over WebSocket", async (t) => {
    const http = new HttpHost({
        auth: { enabled: true, provider: "token", token: WEB_TOKEN },
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    const sessions = new ControlWebSessionService();
    const provider = new ControlWebSocketListener({ http, sessions });
    const closedConnections: string[] = [];
    const channels = new ControlChannelServer({
        listeners: [provider],
        routes: {
            connectionClosed: (connectionId) => closedConnections.push(connectionId),
            snapshot: createRouteSnapshot
        }
    });

    await channels.start();
    await http.start();
    t.after(async () => {
        await channels.close().catch(() => undefined);
        await http.stop().catch(() => undefined);
    });

    const origin = httpOrigin(http);
    const unauthorized = await openRejected(`${origin.replace("http", "ws")}/web/rpc`, {
        protocol: "devshell-control-rpc.v1"
    });
    assert.match(unauthorized, /401/iu);

    const login = await fetch(`${origin}/web/session`, {
        headers: { authorization: `Bearer ${WEB_TOKEN}` },
        method: "POST"
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.notEqual(cookie, null);
    const browserCredentialOnNativePath = await openRejected(
        `${origin.replace("http", "ws")}${CONTROL_REMOTE_RPC_PATH}`,
        {
            cookie: cookie!.split(";", 1)[0]!,
            protocol: "devshell-control-rpc.v1",
        },
    );
    assert.match(browserCredentialOnNativePath, /404/iu);
    const crossOrigin = await openRejected(`${origin.replace("http", "ws")}/web/rpc`, {
        cookie: cookie!.split(";", 1)[0]!,
        origin: "https://attacker.example",
        protocol: "devshell-control-rpc.v1"
    });
    assert.match(crossOrigin, /403/iu);

    const connection = new ClientConnection({
        connectChannel: async () =>
            await NodeWebSocketChannel.connect(
                `${origin.replace("http", "ws")}/web/rpc`,
                cookie!.split(";", 1)[0]!
            ),
        mapError: normalizeError,
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "web"
    });
    t.after(() => connection.close());
    await negotiate(connection, "web");

    assert.deepEqual(
        await connection.request<JsonValue>("@control", "service", "ping"),
        { pong: true }
    );

    const forgedNative = new ClientConnection({
        connectChannel: async () =>
            await NodeWebSocketChannel.connect(
                `${origin.replace("http", "ws")}/web/rpc`,
                cookie!.split(";", 1)[0]!
            ),
        mapError: normalizeError,
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "cli",
    });
    t.after(() => forgedNative.close());
    await assert.rejects(
        negotiate(forgedNative, "cli"),
        (error: unknown) =>
            (error as { code?: string }).code === "control.clientIdentityInvalid",
    );
    forgedNative.close();
    await waitUntil(() => closedConnections.length === 1);
    closedConnections.length = 0;

    const session = await fetch(`${origin}/web/session`, {
        headers: { cookie: cookie!.split(";", 1)[0]! }
    });
    assert.equal(session.status, 200);

    const logout = await fetch(`${origin}/web/session`, {
        headers: { cookie: cookie!.split(";", 1)[0]! },
        method: "DELETE"
    });
    assert.equal(logout.status, 204);

    await waitUntil(() => closedConnections.length === 1);
    await assert.rejects(
        connection.request("@control", "service", "ping"),
        /closed|revoked/iu
    );
    const rejectedAfterLogout = await openRejected(`${origin.replace("http", "ws")}/web/rpc`, {
        cookie: cookie!.split(";", 1)[0]!,
        protocol: "devshell-control-rpc.v1"
    });
    assert.match(rejectedAfterLogout, /401/iu);
});

test("Web none auth stays independent when its shared MCP listener requires OAuth2", async (t) => {
    const storage = await createTestTempDirectory("web-mcp-oauth");
    const port = await reservePort();
    const host = new McpHost({
        instances: [{
            auth: {
                enabled: true,
                oauth2: { requiredScopes: ["mcp"], resourceName: "demo" },
                provider: "oauth2"
            },
            name: "demo",
            policy: { capabilities: ["execute"], groups: ["bash"] },
            worker: createMcpWorker()
        }],
        listenHost: "127.0.0.1",
        listenPort: port,
        publicBaseUrl: `http://127.0.0.1:${port}`,
        storageDir: storage
    });
    const sessions = new ControlWebSessionService();
    const channels = new ControlChannelServer({
        listeners: [new ControlWebSocketListener({ http: host.server, sessions })],
        routes: { connectionClosed() {}, snapshot: createRouteSnapshot }
    });
    await channels.start();
    await host.start();
    t.after(async () => {
        await channels.close().catch(() => undefined);
        await host.stop().catch(() => undefined);
        await rm(storage, { force: true, recursive: true });
    });

    const origin = `http://127.0.0.1:${port}`;
    await assert.rejects(
        WebSocketChannel.connect({
            token: "anonymous-native-is-not-enabled",
            url: `${origin.replace("http", "ws")}${CONTROL_REMOTE_RPC_PATH}`,
        }),
        /failed|rejected|Unauthorized/iu,
    );
    const mcp = await fetch(`${origin}/demo/mcp`, { method: "POST" });
    assert.equal(mcp.status, 401);
    const session = await fetch(`${origin}/web/session`, { method: "POST" });
    assert.equal(session.status, 200);
    const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
    assert.notEqual(cookie, undefined);
    const webSocket = await NodeWebSocketChannel.connect(`${origin.replace("http", "ws")}/web/rpc`, cookie!);
    t.after(() => webSocket.close());
    const connection = new ClientConnection({
        connectChannel: async () => webSocket,
        mapError: normalizeError,
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "web"
    });
    await negotiate(connection, "web");
    assert.deepEqual(
        await connection.request<JsonValue>("@control", "service", "ping"),
        { pong: true },
    );
});

test("web token auth exchanges the configured web bearer token for a session cookie", async (t) => {
    const webToken = "a".repeat(48);
    const http = new HttpHost({
        auth: { enabled: false, provider: "none" },
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    const sessions = new ControlWebSessionService({ auth: { mode: "token", token: webToken } });
    const channels = new ControlChannelServer({
        listeners: [new ControlWebSocketListener({ http, sessions })],
        routes: { connectionClosed() {}, snapshot: createRouteSnapshot }
    });
    await channels.start();
    await http.start();
    t.after(async () => {
        await channels.close().catch(() => undefined);
        await http.stop().catch(() => undefined);
    });

    const origin = httpOrigin(http);
    assert.equal((await fetch(`${origin}/web/session`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${origin}/web/session`, {
        headers: { authorization: "Bearer wrong-token" },
        method: "POST"
    })).status, 401);

    const login = await fetch(`${origin}/web/session`, {
        headers: { authorization: `Bearer ${webToken}` },
        method: "POST"
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    assert.notEqual(cookie, undefined);
    assert.match(login.headers.get("set-cookie")!, /HttpOnly/iu);

    assert.equal((await fetch(`${origin}/web/session`, { headers: { cookie: cookie! } })).status, 200);
    const webSocket = await NodeWebSocketChannel.connect(`${origin.replace("http", "ws")}/web/rpc`, cookie!);
    t.after(() => webSocket.close());
    const connection = new ClientConnection({
        connectChannel: async () => webSocket,
        mapError: normalizeError,
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "web"
    });
    await negotiate(connection, "web");
    assert.deepEqual(
        await connection.request<JsonValue>("@control", "service", "ping"),
        { pong: true },
    );
});

test("web token auth never accepts an MCP namespace bearer token", async (t) => {
    const mcpToken = "m".repeat(48);
    const webToken = "w".repeat(48);
    const http = new HttpHost({
        auth: { enabled: true, provider: "token", token: mcpToken },
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    const sessions = new ControlWebSessionService({ auth: { mode: "token", token: webToken } });
    const channels = new ControlChannelServer({
        listeners: [new ControlWebSocketListener({ http, sessions })],
        routes: { connectionClosed() {}, snapshot: createRouteSnapshot }
    });
    await channels.start();
    await http.start();
    t.after(async () => {
        await channels.close().catch(() => undefined);
        await http.stop().catch(() => undefined);
    });

    const origin = httpOrigin(http);
    const withMcpToken = await fetch(`${origin}/web/session`, {
        headers: { authorization: `Bearer ${mcpToken}` },
        method: "POST"
    });
    assert.equal(withMcpToken.status, 401);

    const withWebToken = await fetch(`${origin}/web/session`, {
        headers: { authorization: `Bearer ${webToken}` },
        method: "POST"
    });
    assert.equal(withWebToken.status, 200);
});


test("web routes and cookies follow the public base URL path prefix", async (t) => {
    const basePath = controlWebBasePath("https://controller.example/devshell");
    const assetDirectory = await createTestTempDirectory("web-prefix");
    await writeFile(join(assetDirectory, "index.html"), '<script src="./assets/app.js"></script>', "utf8");
    t.after(async () => await rm(assetDirectory, { force: true, recursive: true }));
    const http = new HttpHost({
        auth: { enabled: false, provider: "none" },
        listenHost: "127.0.0.1",
        listenPort: 0,
        publicBaseUrl: "https://controller.example/devshell"
    });
    const sessions = new ControlWebSessionService({ basePath });
    const channels = new ControlChannelServer({
        listeners: [new ControlWebSocketListener({ assetDirectory, basePath, http, sessions })],
        routes: {
            connectionClosed() {},
            snapshot: createRouteSnapshot
        }
    });
    await channels.start();
    await http.start();
    t.after(async () => {
        await channels.close().catch(() => undefined);
        await http.stop().catch(() => undefined);
    });

    const origin = httpOrigin(http);
    const index = await fetch(`${origin}${basePath}/`);
    assert.equal(index.status, 200);
    assert.equal(await index.text(), '<script src="./assets/app.js"></script>');
    assert.equal((await fetch(`${origin}/web/session`, { method: "POST" })).status, 404);
    const login = await fetch(`${origin}${basePath}/session`, { method: "POST" });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie");
    assert.notEqual(setCookie, null);
    assert.match(setCookie!, /Path=\/devshell\/web(?:;|$)/u);
    const cookie = setCookie!.split(";", 1)[0]!;

    const rejectedLegacyPath = await openRejected(`${origin.replace("http", "ws")}/web/rpc`, {
        cookie,
        protocol: "devshell-control-rpc.v1"
    });
    assert.match(rejectedLegacyPath, /404/iu);

    const connection = new ClientConnection({
        connectChannel: async () =>
            await NodeWebSocketChannel.connect(
                `${origin.replace("http", "ws")}${basePath}/rpc`,
                cookie
            ),
        mapError: normalizeError,
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "web"
    });
    t.after(() => connection.close());
    await negotiate(connection, "web");
    assert.deepEqual(
        await connection.request<JsonValue>("@control", "service", "ping"),
        { pong: true }
    );
});


test("web session expiry closes its active channel", async (t) => {
    const http = new HttpHost({
        auth: { enabled: false, provider: "none" },
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    const channels = new ControlChannelServer({
        listeners: [new ControlWebSocketListener({
            http,
            sessions: new ControlWebSessionService({ sessionTtlMs: 30 })
        })],
        routes: {
            connectionClosed() {},
            snapshot: createRouteSnapshot
        }
    });
    await channels.start();
    await http.start();
    t.after(async () => {
        await channels.close().catch(() => undefined);
        await http.stop().catch(() => undefined);
    });

    const origin = httpOrigin(http);
    const login = await fetch(`${origin}/web/session`, { method: "POST" });
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    assert.equal(login.status, 200);
    assert.notEqual(cookie, undefined);
    const channel = await NodeWebSocketChannel.connect(
        `${origin.replace("http", "ws")}/web/rpc`,
        cookie!
    );
    t.after(() => channel.close());

    await waitUntil(() => channel.closed);
    const expiredSession = await fetch(`${origin}/web/session`, {
        headers: { cookie: cookie! }
    });
    assert.equal(expiredSession.status, 200);
    assert.deepEqual(await expiredSession.json(), { auth: "none", authenticated: false });
});

test("web RPC requires the canonical subprotocol", async (t) => {
    const http = new HttpHost({
        auth: { enabled: false, provider: "none" },
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    const channels = new ControlChannelServer({
        listeners: [new ControlWebSocketListener({
            http,
            sessions: new ControlWebSessionService()
        })],
        routes: {
            connectionClosed() {},
            snapshot: createRouteSnapshot
        }
    });
    await channels.start();
    await http.start();
    t.after(async () => {
        await channels.close().catch(() => undefined);
        await http.stop().catch(() => undefined);
    });

    const origin = httpOrigin(http);
    const login = await fetch(`${origin}/web/session`, { method: "POST" });
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    assert.equal(login.status, 200);
    assert.notEqual(cookie, undefined);

    const rejected = await openRejected(`${origin.replace("http", "ws")}/web/rpc`, {
        cookie,
        protocol: "wrong-protocol"
    });
    assert.match(rejected, /426|400/iu);
});

test("web session capacity evicts the oldest browser session and closes its channel", async (t) => {
    const http = new HttpHost({
        auth: { enabled: false, provider: "none" },
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    const channels = new ControlChannelServer({
        listeners: [new ControlWebSocketListener({
            http,
            sessions: new ControlWebSessionService({
                maxSessions: 1,
                tokenFactory: (() => {
                    let next = 0;
                    return () => `session-${++next}`;
                })()
            })
        })],
        routes: {
            connectionClosed() {},
            snapshot: createRouteSnapshot
        }
    });
    await channels.start();
    await http.start();
    t.after(async () => {
        await channels.close().catch(() => undefined);
        await http.stop().catch(() => undefined);
    });

    const origin = httpOrigin(http);
    const first = await fetch(`${origin}/web/session`, { method: "POST" });
    const firstCookie = first.headers.get("set-cookie")?.split(";", 1)[0];
    assert.equal(first.status, 200);
    assert.notEqual(firstCookie, undefined);
    const firstChannel = await NodeWebSocketChannel.connect(
        `${origin.replace("http", "ws")}/web/rpc`,
        firstCookie!
    );
    t.after(() => firstChannel.close());

    const second = await fetch(`${origin}/web/session`, { method: "POST" });
    const secondCookie = second.headers.get("set-cookie")?.split(";", 1)[0];
    assert.equal(second.status, 200);
    assert.notEqual(secondCookie, undefined);
    await waitUntil(() => firstChannel.closed);

    const evictedSession = await fetch(`${origin}/web/session`, {
        headers: { cookie: firstCookie! }
    });
    assert.equal(evictedSession.status, 200);
    assert.deepEqual(await evictedSession.json(), { auth: "none", authenticated: false });
    assert.equal((await fetch(`${origin}/web/session`, {
        headers: { cookie: secondCookie! }
    })).status, 200);
});


test("native TUI and CLI bearer clients use the shared remote Control WebSocket route", async (t) => {
    const remoteToken = "r".repeat(48);
    const http = new HttpHost({
        auth: { enabled: false, provider: "none" },
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    const sessions = new ControlWebSessionService({
        auth: { mode: "token", token: remoteToken }
    });
    const channels = new ControlChannelServer({
        listeners: [new ControlWebSocketListener({
            access: new ControlWebSocketAccessService({ sessions }),
            http,
            sessions
        })],
        routes: { connectionClosed() {}, snapshot: createRouteSnapshot }
    });
    await channels.start();
    await http.start();
    t.after(async () => {
        await channels.close().catch(() => undefined);
        await http.stop().catch(() => undefined);
    });

    const origin = httpOrigin(http);
    const url = `${origin.replace("http", "ws")}${CONTROL_REMOTE_RPC_PATH}`;
    await assert.rejects(
        WebSocketChannel.connect({ token: "wrong-token", url }),
        /failed|rejected|Unauthorized/iu
    );
    await assert.rejects(
        WebSocketChannel.connect({
            token: remoteToken,
            url: `${origin.replace("http", "ws")}/web/rpc`,
        }),
        /failed|rejected|Unauthorized/iu,
    );

    for (const peer of ["tui", "cli"] as const) {
        const connection = new ClientConnection({
            connectChannel: (signal) =>
                WebSocketChannel.connect({ token: remoteToken, url }, signal),
            mapError: normalizeError,
            mapRemoteError: (error) => createError(error),
            mode: "persistent",
            peer
        });
        t.after(() => connection.close());
        await negotiate(connection, peer);
        assert.deepEqual(
            await connection.request<JsonValue>("@control", "service", "ping"),
            { pong: true }
        );
    }
    const forgedWeb = new ClientConnection({
        connectChannel: (signal) =>
            WebSocketChannel.connect({ token: remoteToken, url }, signal),
        mapError: normalizeError,
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "web",
    });
    t.after(() => forgedWeb.close());
    await assert.rejects(
        negotiate(forgedWeb, "web"),
        (error: unknown) =>
            (error as { code?: string }).code === "control.clientIdentityInvalid",
    );
});

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
                        { name: "ping", handle: () => ({ pong: true }) }
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

function httpOrigin(server: HttpHost): string {
    const address = server.address as AddressInfo | null | undefined;
    if (address === null || address === undefined || typeof address === "string") {
        throw new Error("HTTP server did not expose a TCP address.");
    }
    return `http://127.0.0.1:${address.port}`;
}

function createMcpWorker() {
    return {
        async appendMcpSessionClosed() {},
        async appendMcpSessionOpened() {},
        async appendMcpToolCalled() {},
        async callTool() { return { exitCode: 0, stderr: "", stdout: "" }; },
        listTools() { return []; },
        snapshot() { return { ready: true }; }
    } as never;
}

async function reservePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Port reservation failed.");
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    return address.port;
}

async function openRejected(
    url: string,
    options: { cookie?: string; origin?: string; protocol: string }
): Promise<string> {
    return await new Promise<string>((resolve) => {
        const headers: Record<string, string> = {};
        if (options.cookie !== undefined) headers.cookie = options.cookie;
        if (options.origin !== undefined) headers.origin = options.origin;
        const socket = new WebSocket(url, options.protocol, {
            headers: Object.keys(headers).length === 0 ? undefined : headers
        });
        socket.once("unexpected-response", (_request, response) => {
            resolve(`${response.statusCode} ${response.statusMessage ?? ""}`);
            response.resume();
        });
        socket.once("error", (error) => resolve(error.message));
        socket.once("open", () => {
            socket.close();
            resolve("unexpected open");
        });
    });
}

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for condition.");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
