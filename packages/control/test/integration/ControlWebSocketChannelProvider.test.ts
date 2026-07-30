import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { McpHostHttpServer } from "@portable-devshell/mcp";
import {
    ClientConnection,
    PrefixRoute,
    controlWebBasePath,
    createError,
    type FrameChannel,
    type JsonValue,
    type PrefixRouteSnapshot
} from "@portable-devshell/shared";
import WebSocket, { type RawData } from "ws";

import { ControlChannelServer } from "../../src/server/channel/ControlChannelServer.ts";
import { ControlWebSessionService } from "../../src/server/web/ControlWebSessionService.ts";
import { ControlWebSocketChannelProvider } from "../../src/server/web/ControlWebSocketChannelProvider.ts";

const WEB_TOKEN = "portable-devshell-web-token-value";

test("web session cookie authenticates the shared control RPC over WebSocket", async (t) => {
    const http = new McpHostHttpServer({
        auth: { enabled: true, provider: "token", token: WEB_TOKEN },
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    const sessions = new ControlWebSessionService();
    const provider = new ControlWebSocketChannelProvider({ http, sessions });
    const closedConnections: string[] = [];
    const channels = new ControlChannelServer({
        providers: [provider],
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
    assert.equal(login.status, 204);
    const cookie = login.headers.get("set-cookie");
    assert.notEqual(cookie, null);
    const crossOrigin = await openRejected(`${origin.replace("http", "ws")}/web/rpc`, {
        cookie: cookie!.split(";", 1)[0]!,
        origin: "https://attacker.example",
        protocol: "devshell-control-rpc.v1"
    });
    assert.match(crossOrigin, /403/iu);

    const connection = new ClientConnection({
        channelProvider: {
            connect: async () => await NodeWebSocketFrameChannel.connect(
                `${origin.replace("http", "ws")}/web/rpc`,
                cookie!.split(";", 1)[0]!
            )
        },
        mapError: normalizeError,
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "web"
    });
    t.after(() => connection.close());

    assert.deepEqual(
        await connection.request<JsonValue>("@control", "service", "ping"),
        { pong: true }
    );

    const session = await fetch(`${origin}/web/session`, {
        headers: { cookie: cookie!.split(";", 1)[0]! }
    });
    assert.equal(session.status, 204);

    const logout = await fetch(`${origin}/web/session`, {
        headers: { cookie: cookie!.split(";", 1)[0]! },
        method: "DELETE"
    });
    assert.equal(logout.status, 204);

    connection.close();
    await waitUntil(() => closedConnections.length === 1);
    const rejectedAfterLogout = await openRejected(`${origin.replace("http", "ws")}/web/rpc`, {
        cookie: cookie!.split(";", 1)[0]!,
        protocol: "devshell-control-rpc.v1"
    });
    assert.match(rejectedAfterLogout, /401/iu);
});


test("web routes and cookies follow the public base URL path prefix", async (t) => {
    const basePath = controlWebBasePath("https://controller.example/devshell");
    const assetDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-web-prefix-"));
    await writeFile(join(assetDirectory, "index.html"), '<script src="./assets/app.js"></script>', "utf8");
    t.after(async () => await rm(assetDirectory, { force: true, recursive: true }));
    const http = new McpHostHttpServer({
        auth: { enabled: false, provider: "none" },
        listenHost: "127.0.0.1",
        listenPort: 0,
        publicBaseUrl: "https://controller.example/devshell"
    });
    const sessions = new ControlWebSessionService({ basePath });
    const channels = new ControlChannelServer({
        providers: [new ControlWebSocketChannelProvider({ assetDirectory, basePath, http, sessions })],
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
    assert.equal(login.status, 204);
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
        channelProvider: {
            connect: async () => await NodeWebSocketFrameChannel.connect(
                `${origin.replace("http", "ws")}${basePath}/rpc`,
                cookie
            )
        },
        mapError: normalizeError,
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "web"
    });
    t.after(() => connection.close());
    assert.deepEqual(
        await connection.request<JsonValue>("@control", "service", "ping"),
        { pong: true }
    );
});

test("web RPC requires the canonical subprotocol", async (t) => {
    const http = new McpHostHttpServer({
        auth: { enabled: false, provider: "none" },
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    const channels = new ControlChannelServer({
        providers: [new ControlWebSocketChannelProvider({
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
    assert.equal(login.status, 204);
    assert.notEqual(cookie, undefined);

    const rejected = await openRejected(`${origin.replace("http", "ws")}/web/rpc`, {
        cookie,
        protocol: "wrong-protocol"
    });
    assert.match(rejected, /426|400/iu);
});

test("web session capacity evicts the oldest browser session", async (t) => {
    const http = new McpHostHttpServer({
        auth: { enabled: false, provider: "none" },
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    const channels = new ControlChannelServer({
        providers: [new ControlWebSocketChannelProvider({
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
    const second = await fetch(`${origin}/web/session`, { method: "POST" });
    const secondCookie = second.headers.get("set-cookie")?.split(";", 1)[0];
    assert.equal(first.status, 204);
    assert.equal(second.status, 204);
    assert.notEqual(firstCookie, undefined);
    assert.notEqual(secondCookie, undefined);

    assert.equal((await fetch(`${origin}/web/session`, {
        headers: { cookie: firstCookie! }
    })).status, 401);
    assert.equal((await fetch(`${origin}/web/session`, {
        headers: { cookie: secondCookie! }
    })).status, 204);
});

class NodeWebSocketFrameChannel implements FrameChannel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #frameListeners = new Set<(frame: Uint8Array) => void>();
    readonly #socket: WebSocket;
    #closed = false;
    #closeError?: Error;

    private constructor(socket: WebSocket) {
        this.#socket = socket;
        socket.on("message", (data, isBinary) => this.#accept(data, isBinary));
        socket.once("error", (error) => this.#finish(error));
        socket.once("close", (code, reason) => {
            this.#finish(code === 1000 ? undefined : new Error(`WebSocket closed: ${code} ${reason.toString()}`));
        });
    }

    static async connect(url: string, cookie: string): Promise<NodeWebSocketFrameChannel> {
        const socket = new WebSocket(url, "devshell-control-rpc.v1", {
            headers: { cookie }
        });
        await new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
        });
        return new NodeWebSocketFrameChannel(socket);
    }

    get closed(): boolean {
        return this.#closed;
    }

    async send(frame: Uint8Array): Promise<void> {
        if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
            throw this.#closeError ?? new Error("WebSocket channel is closed.");
        }
        await new Promise<void>((resolve, reject) => {
            this.#socket.send(frame, { binary: true }, (error) => error == null ? resolve() : reject(error));
        });
    }

    onFrame(listener: (frame: Uint8Array) => void): () => void {
        this.#frameListeners.add(listener);
        return () => this.#frameListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    close(error?: Error): void {
        if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
            this.#socket.close(1000, "client closed");
        }
        this.#finish(error);
    }

    #accept(data: RawData, isBinary: boolean): void {
        if (!isBinary) {
            this.#finish(new Error("Expected binary WebSocket frame."));
            return;
        }
        const frame = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data as ArrayBuffer);
        for (const listener of [...this.#frameListeners]) {
            listener(frame);
        }
    }

    #finish(error?: Error): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#closeError = error;
        for (const listener of [...this.#closeListeners]) {
            listener(error);
        }
        this.#closeListeners.clear();
    }
}

function createRouteSnapshot(): PrefixRouteSnapshot {
    return PrefixRoute.snapshot([
        {
            destination: "@control",
            modules: [
                {
                    name: "service",
                    operations: [
                        { name: "ping", handle: () => ({ pong: true }) }
                    ]
                }
            ]
        }
    ]);
}

function httpOrigin(server: McpHostHttpServer): string {
    const address = server.address as AddressInfo | null | undefined;
    if (address === null || address === undefined || typeof address === "string") {
        throw new Error("HTTP server did not expose a TCP address.");
    }
    return `http://127.0.0.1:${address.port}`;
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
