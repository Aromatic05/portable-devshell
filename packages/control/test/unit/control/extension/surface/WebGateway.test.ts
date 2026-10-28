import assert from "node:assert/strict";
import {
    createServer,
    request as httpRequest,
    type IncomingMessage,
} from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { HttpHost } from "@portable-devshell/mcp/testing";
import { WebSocket, WebSocketServer } from "ws";

import { ExtensionPathLayout } from "../../../../../src/extension/state/Layout.ts";
import { ControlWebSessionService } from "../../../../../src/server/web/auth/Session.ts";
import { ExtensionWebGateway } from "../../../../../src/server/web/extension/application/Gateway.ts";
import { createTestTempDirectory } from "../../../../../../../test/TestTempDirectory.ts";

test("Extension Web proxy authenticates one generic namespace, strips credentials, and holds the generation lease through WebSocket close", async () => {
    const observed: Array<{
        authorization?: string;
        cookie?: string;
        path?: string;
        prefix?: string;
    }> = [];
    let resolveHangingClosed!: () => void;
    const hangingClosed = new Promise<void>((resolve) => {
        resolveHangingClosed = resolve;
    });
    const upstreamServer = createServer((request, response) => {
        observed.push({
            ...(typeof request.headers.authorization === "string"
                ? { authorization: request.headers.authorization }
                : {}),
            ...(typeof request.headers.cookie === "string"
                ? { cookie: request.headers.cookie }
                : {}),
            path: request.url,
            ...(typeof request.headers["x-forwarded-prefix"] === "string"
                ? { prefix: request.headers["x-forwarded-prefix"] }
                : {}),
        });
        if (request.url === "/api/hang") {
            response.statusCode = 200;
            response.setHeader("content-type", "text/plain");
            response.once("close", resolveHangingClosed);
            response.write("open\n");
            return;
        }
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.setHeader("set-cookie", "extension_secret=must-not-escape");
        response.end(JSON.stringify({ ok: true, path: request.url }));
    });
    const upstreamWebSockets = new WebSocketServer({ server: upstreamServer });
    let observedUpgrade:
        | {
              authorization?: string;
              cookie?: string;
              path?: string;
              prefix?: string;
          }
        | undefined;
    let websocketConnections = 0;
    let resolveAbruptUpstreamClosed!: () => void;
    const abruptUpstreamClosed = new Promise<void>((resolve) => {
        resolveAbruptUpstreamClosed = resolve;
    });
    upstreamWebSockets.on("connection", (socket, request) => {
        websocketConnections += 1;
        if (websocketConnections === 2)
            socket.once("close", resolveAbruptUpstreamClosed);
        observedUpgrade = {
            ...(typeof request.headers.authorization === "string"
                ? { authorization: request.headers.authorization }
                : {}),
            ...(typeof request.headers.cookie === "string"
                ? { cookie: request.headers.cookie }
                : {}),
            path: request.url,
            ...(typeof request.headers["x-forwarded-prefix"] === "string"
                ? { prefix: request.headers["x-forwarded-prefix"] }
                : {}),
        };
        socket.on("message", (message) =>
            socket.send(`echo:${message.toString()}`),
        );
    });
    await new Promise<void>((resolve, reject) => {
        upstreamServer.once("error", reject);
        upstreamServer.listen(0, "127.0.0.1", resolve);
    });
    const upstreamAddress = upstreamServer.address();
    assert.ok(typeof upstreamAddress === "object" && upstreamAddress !== null);
    const upstream = new URL(`http://127.0.0.1:${upstreamAddress.port}/`);
    let leases = 0;
    let releases = 0;
    const extensions = {
        listDeclarations(pointId: string) {
            assert.equal(pointId, "web.applications");
            return [
                { extensionId: "example", generation: "g1", id: "example" },
            ];
        },
        acquireRegistration(pointId: string, id: string) {
            assert.equal(pointId, "web.applications");
            assert.equal(id, "example");
            leases += 1;
            let released = false;
            return {
                extensionId: "example",
                lease: {
                    generation: "g1",
                    release() {
                        if (released) return;
                        released = true;
                        leases -= 1;
                        releases += 1;
                    },
                },
                registration: {
                    binding: {
                        source: {
                            kind: "endpoint" as const,
                            resolve: () => upstream,
                        },
                    },
                    declaration: { id: "example", title: "Example" },
                    id: "example",
                    pointId: "web.applications",
                },
            };
        },
    };
    const http = new HttpHost({ listenHost: "127.0.0.1", listenPort: 0 });
    const sessions = new ControlWebSessionService({
        auth: { mode: "none" },
        basePath: "/web",
    });
    const removeSessionRoutes = sessions.install(http);
    const removeGateway = new ExtensionWebGateway({
        basePath: "/web/extensions",
        extensions: extensions as never,
        loginPath: "/web/",
    }).install(http, sessions);

    try {
        await http.start();
        const address = http.address;
        assert.ok(typeof address === "object" && address !== null);
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const entry = await fetch(
            `${baseUrl}/web/extensions/example/?view=one`,
            { redirect: "manual" },
        );
        assert.equal(entry.status, 302);
        const login = new URL(entry.headers.get("location")!, baseUrl);
        assert.equal(login.pathname, "/web/");
        assert.equal(
            login.searchParams.get("returnTo"),
            "/web/extensions/example/?view=one",
        );
        assert.equal(leases, 0);

        const unauthorized = await fetch(
            `${baseUrl}/web/extensions/example/api/sessions`,
        );
        assert.equal(unauthorized.status, 401);
        assert.equal(leases, 0);

        const sessionResponse = await fetch(`${baseUrl}/web/session`, {
            method: "POST",
        });
        assert.equal(sessionResponse.status, 200);
        const cookie = sessionCookie(sessionResponse.headers.get("set-cookie"));

        const proxied = await fetch(
            `${baseUrl}/web/extensions/example/api/sessions?view=full`,
            {
                headers: {
                    authorization: "Bearer must-not-reach-extension",
                    cookie,
                },
            },
        );
        assert.equal(proxied.status, 200);
        assert.equal(proxied.headers.get("set-cookie"), null);
        assert.deepEqual(await proxied.json(), {
            ok: true,
            path: "/api/sessions?view=full",
        });
        assert.deepEqual(observed.at(-1), {
            path: "/api/sessions?view=full",
            prefix: "/web/extensions/example",
        });
        assert.equal(leases, 0);
        assert.equal(releases, 1);

        const hanging = await openStreamingResponse(
            `${baseUrl}/web/extensions/example/api/hang`,
            cookie,
        );
        assert.equal(leases, 1);
        hanging.destroy();
        await hangingClosed;
        await waitFor(() => leases === 0);
        assert.equal(releases, 2);

        const socket = new WebSocket(
            `ws://127.0.0.1:${address.port}/web/extensions/example/socket?mode=live`,
            {
                headers: {
                    authorization: "Bearer must-not-reach-extension",
                    cookie,
                },
            },
        );
        await new Promise<void>((resolve, reject) => {
            socket.once("error", reject);
            socket.once("open", resolve);
        });
        assert.equal(leases, 1);
        const echoed = await new Promise<string>((resolve, reject) => {
            socket.once("error", reject);
            socket.once("message", (message) => resolve(message.toString()));
            socket.send("hello");
        });
        assert.equal(echoed, "echo:hello");
        assert.deepEqual(observedUpgrade, {
            path: "/socket?mode=live",
            prefix: "/web/extensions/example",
        });
        assert.equal(leases, 1);
        const closed = new Promise<void>((resolve) =>
            socket.once("close", () => resolve()),
        );
        socket.close();
        await closed;
        await waitFor(() => leases === 0);
        assert.equal(releases, 3);

        const abrupt = new WebSocket(
            `ws://127.0.0.1:${address.port}/web/extensions/example/socket?mode=abrupt`,
            { headers: { cookie } },
        );
        await new Promise<void>((resolve, reject) => {
            abrupt.once("error", reject);
            abrupt.once("open", resolve);
        });
        assert.equal(leases, 1);
        abrupt.terminate();
        await abruptUpstreamClosed;
        await waitFor(() => leases === 0);
        assert.equal(releases, 4);
    } finally {
        removeGateway();
        removeSessionRoutes();
        await http.stop();
        upstreamWebSockets.close();
        await new Promise<void>((resolve, reject) =>
            upstreamServer.close((error) =>
                error ? reject(error) : resolve(),
            ),
        );
    }
});

for (const revocation of [
    "DELETE",
    "expiry",
    "eviction",
    "acquire",
    "resolve",
    "upstream",
] as const) {
    test(`Extension WebSocket ${revocation} closes only the revoked session and releases its generation`, async () => {
        const racing =
            revocation === "acquire" ||
            revocation === "resolve" ||
            revocation === "upstream";
        let unblock!: () => void;
        const blocked = new Promise<void>((resolve) => {
            unblock = resolve;
        });
        let reached = false;
        let firstAcquisition = true;
        let pendingUpstreamEnded = false;
        let pendingUpstreamClosed = false;
        const upstreamServer = createServer();
        const upstreamWebSockets = new WebSocketServer({ noServer: true });
        let firstUpgrade = true;
        upstreamServer.on("upgrade", async (request, socket, head) => {
            if (firstUpgrade && revocation === "upstream") {
                firstUpgrade = false;
                socket.on("error", () => undefined);
                socket.once("end", () => {
                    pendingUpstreamEnded = true;
                });
                socket.once("close", () => {
                    pendingUpstreamClosed = true;
                });
                reached = true;
                socket.resume();
                await blocked;
            }
            upstreamWebSockets.handleUpgrade(
                request,
                socket,
                head,
                (webSocket) => {
                    upstreamWebSockets.emit("connection", webSocket, request);
                },
            );
        });
        const received: string[] = [];
        const upstreamSockets: WebSocket[] = [];
        upstreamWebSockets.on("connection", (socket) => {
            upstreamSockets.push(socket);
            socket.on("message", (message) => {
                received.push(message.toString());
                socket.send(`echo:${message.toString()}`);
            });
        });
        await new Promise<void>((resolve) =>
            upstreamServer.listen(0, "127.0.0.1", resolve),
        );
        const upstreamAddress = upstreamServer.address();
        assert.ok(
            typeof upstreamAddress === "object" && upstreamAddress !== null,
        );
        let leases = 0;
        let releases = 0;
        const extensions = {
            listDeclarations: () => [{ id: "example" }],
            acquireRegistration: async () => {
                const first = firstAcquisition;
                firstAcquisition = false;
                if (first && revocation === "acquire") {
                    reached = true;
                    await blocked;
                }
                leases += 1;
                return {
                    lease: {
                        generation: "g1",
                        release() {
                            leases -= 1;
                            releases += 1;
                        },
                    },
                    registration: {
                        binding: {
                            source: {
                                kind: "endpoint",
                                resolve: async () => {
                                    if (first && revocation === "resolve") {
                                        reached = true;
                                        await blocked;
                                    }
                                    return new URL(
                                        `http://127.0.0.1:${upstreamAddress.port}/`,
                                    );
                                },
                            },
                        },
                    },
                };
            },
        };
        const http = new HttpHost({ listenHost: "127.0.0.1", listenPort: 0 });
        const sessions = new ControlWebSessionService({
            auth: { mode: "none" },
            basePath: "/web",
            maxSessions: 2,
            sessionTtlMs: revocation === "expiry" ? 1_500 : 60_000,
        });
        const removeSessions = sessions.install(http);
        const removeGateway = new ExtensionWebGateway({
            basePath: "/web/extensions",
            extensions: extensions as never,
            loginPath: "/web/",
        }).install(http, sessions);
        const clients: WebSocket[] = [];
        let removeRevoked = () => {};
        try {
            await http.start();
            const address = http.address;
            assert.ok(typeof address === "object" && address !== null);
            const baseUrl = `http://127.0.0.1:${address.port}`;
            const createSession = async () => {
                const response = await fetch(`${baseUrl}/web/session`, {
                    method: "POST",
                });
                assert.equal(response.status, 200);
                return sessionCookie(response.headers.get("set-cookie"));
            };
            const connect = async (cookie: string) => {
                const socket = new WebSocket(
                    `${baseUrl.replace("http:", "ws:")}/web/extensions/example/socket`,
                    { headers: { cookie } },
                );
                clients.push(socket);
                await new Promise<void>((resolve, reject) => {
                    socket.once("error", reject);
                    socket.once("open", resolve);
                });
                return socket;
            };
            const cookieA = await createSession();
            if (racing) {
                const admission = connect(cookieA).then(
                    () => "opened",
                    () => "rejected",
                );
                await waitFor(() => reached);
                const b = await connect(await createSession());
                assert.equal(await echoMessage(b, "before-B"), "echo:before-B");
                const response = await fetch(`${baseUrl}/web/session`, {
                    method: "DELETE",
                    headers: { cookie: cookieA },
                });
                assert.equal(response.status, 204);
                await waitFor(
                    () => clients[0]?.readyState === WebSocket.CLOSED,
                );
                if (revocation === "resolve" || revocation === "upstream") {
                    // Downstream close must release A's lease before the blocked work resumes.
                    await waitFor(() => leases === 1);
                    assert.equal(releases, 1);
                }
                if (revocation === "upstream") {
                    // HTTP upgrade sockets allow half-open connections. Observe the proxy's FIN
                    // before resuming handleUpgrade, which destroys the now-unreadable peer.
                    await waitFor(() => pendingUpstreamEnded);
                    await new Promise<void>((resolve) =>
                        clients[0]!.send("NEW-after-upstream", () => resolve()),
                    );
                }
                unblock();
                assert.equal(await admission, "rejected");
                await waitFor(() => releases === 1 && leases === 1);
                if (revocation === "upstream") {
                    await waitFor(() => pendingUpstreamClosed);
                    assert.equal(
                        (
                            await requestUpgradeFailure(
                                `${baseUrl}/web/extensions/example/socket`,
                                cookieA,
                            )
                        ).statusCode,
                        401,
                    );
                }
                assert.equal(
                    await echoMessage(b, "NEW-independent-B"),
                    "echo:NEW-independent-B",
                );
                assert.equal(upstreamSockets.length, 1);
                if (revocation === "upstream")
                    assert.equal(received.includes("NEW-after-upstream"), false);
                b.terminate();
                await waitFor(() => releases === 2 && leases === 0);
                return;
            }
            const a = await connect(cookieA);
            assert.equal(await echoMessage(a, "before-A"), "echo:before-A");
            if (revocation === "expiry")
                await new Promise((resolve) => setTimeout(resolve, 900));
            const b = await connect(await createSession());
            assert.equal(await echoMessage(b, "before-B"), "echo:before-B");
            assert.equal(leases, 2);
            const revoked = new Promise<void>((resolve) => {
                removeRevoked = sessions.onRevoked((token) => {
                    if (cookieA === `devshell_web_session=${token}`) resolve();
                });
            });
            if (revocation === "DELETE") {
                const response = await fetch(`${baseUrl}/web/session`, {
                    method: "DELETE",
                    headers: { cookie: cookieA },
                });
                assert.equal(response.status, 204);
            } else if (revocation === "eviction") {
                await createSession();
            }
            await revoked;
            const nonce = `NEW-after-${revocation}`;
            await new Promise<void>((resolve) =>
                a.send(nonce, () => resolve()),
            );
            // A round trip through B also gives the upstream a chance to observe stray A data.
            assert.equal(await echoMessage(b, nonce + "-B"), `echo:${nonce}-B`);
            assert.equal(received.includes(nonce), false);
            await waitFor(() => a.readyState === WebSocket.CLOSED);
            await waitFor(
                () =>
                    upstreamSockets[0]?.readyState === WebSocket.CLOSED &&
                    leases === 1,
            );
            assert.equal(releases, 1);
            assert.equal(upstreamSockets[1]?.readyState, WebSocket.OPEN);
            assert.equal(
                (
                    await requestUpgradeFailure(
                        `${baseUrl}/web/extensions/example/socket`,
                        cookieA,
                    )
                ).statusCode,
                401,
            );
            b.terminate();
            await waitFor(() => leases === 0);
            assert.equal(releases, 2);
        } finally {
            removeRevoked();
            unblock();
            for (const socket of clients) socket.terminate();
            for (const socket of upstreamSockets) socket.terminate();
            sessions.clear();
            removeGateway();
            removeSessions();
            await http.stop();
            upstreamWebSockets.close();
            await new Promise<void>((resolve) =>
                upstreamServer.close(() => resolve()),
            );
        }
    });
}

async function echoMessage(socket: WebSocket, value: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("message", (message) => resolve(message.toString()));
        socket.send(value);
    });
}

test("Extension static Web contribution serves only files contained by the immutable generation", async (t) => {
    const root = await createTestTempDirectory("extension-web-static");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const paths = new ExtensionPathLayout({
        dataHome: join(root, "data"),
        homeDirectory: join(root, "home"),
        runtimeRoot: join(root, "runtime"),
    });
    const codeDirectory = paths.generationDirectory("example", "g1");
    await mkdir(join(codeDirectory, "web", "assets"), { recursive: true });
    await writeFile(
        join(codeDirectory, "web", "index.html"),
        "<main>extension</main>\n",
        "utf8",
    );
    await writeFile(
        join(codeDirectory, "web", "assets", "app.js"),
        "console.log('extension');\n",
        "utf8",
    );
    await writeFile(join(codeDirectory, "outside.txt"), "not web\n", "utf8");
    let leases = 0;
    const extensions = {
        listDeclarations(pointId: string) {
            assert.equal(pointId, "web.applications");
            return [
                { extensionId: "example", generation: "g1", id: "example" },
            ];
        },
        acquireRegistration(pointId: string, id: string) {
            assert.equal(pointId, "web.applications");
            assert.equal(id, "example");
            leases += 1;
            let released = false;
            return {
                extensionId: "example",
                lease: {
                    generation: "g1",
                    release() {
                        if (released) return;
                        released = true;
                        leases -= 1;
                    },
                },
                registration: {
                    binding: {
                        source: { directory: "web", kind: "files" as const },
                    },
                    declaration: { id: "example", title: "Example" },
                    id: "example",
                    pointId: "web.applications",
                },
            };
        },
        generationDirectory(id: string, generation: string) {
            return paths.generationDirectory(id, generation);
        },
    };
    const http = new HttpHost({ listenHost: "127.0.0.1", listenPort: 0 });
    const sessions = new ControlWebSessionService({
        auth: { mode: "none" },
        basePath: "/web",
    });
    const removeSessions = sessions.install(http);
    const removeGateway = new ExtensionWebGateway({
        basePath: "/web/extensions",
        extensions: extensions as never,
        loginPath: "/web/",
    }).install(http, sessions);
    try {
        await http.start();
        const address = http.address;
        assert.ok(typeof address === "object" && address !== null);
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const sessionResponse = await fetch(`${baseUrl}/web/session`, {
            method: "POST",
        });
        const cookie = sessionCookie(sessionResponse.headers.get("set-cookie"));

        const index = await fetch(`${baseUrl}/web/extensions/example/`, {
            headers: { cookie },
        });
        assert.equal(index.status, 200);
        assert.equal(await index.text(), "<main>extension</main>\n");
        assert.match(
            index.headers.get("content-security-policy") ?? "",
            /default-src 'self'/u,
        );
        assert.equal(index.headers.get("cache-control"), "no-cache");

        const asset = await fetch(
            `${baseUrl}/web/extensions/example/assets/app.js`,
            { headers: { cookie } },
        );
        assert.equal(asset.status, 200);
        assert.equal(
            asset.headers.get("cache-control"),
            "public, max-age=31536000, immutable",
        );

        const escape = await fetch(
            `${baseUrl}/web/extensions/example/%2e%2e/outside.txt`,
            { headers: { cookie } },
        );
        assert.equal(escape.status, 404);
        assert.equal(leases, 0);
    } finally {
        removeGateway();
        removeSessions();
        await http.stop();
    }
});

test("Extension Web gateway owns 404/502/503 semantics without leaking host or upstream failures", async () => {
    const unavailableUpstream = await unusedLoopbackUrl();
    let leases = 0;
    let releases = 0;
    const published = [
        "activation-fails",
        "source-fails",
        "upstream-fails",
    ] as const;
    const extensions = {
        listDeclarations(pointId: string) {
            assert.equal(pointId, "web.applications");
            return published.map((id) => ({
                extensionId: id,
                generation: "g1",
                id,
            }));
        },
        acquireRegistration(pointId: string, id: string) {
            assert.equal(pointId, "web.applications");
            if (id === "activation-fails") {
                throw new Error("ACTIVATION_SECRET /private/generation/path");
            }
            assert.ok(id === "source-fails" || id === "upstream-fails");
            leases += 1;
            let released = false;
            return {
                extensionId: id,
                lease: {
                    generation: "g1",
                    release() {
                        if (released) return;
                        released = true;
                        leases -= 1;
                        releases += 1;
                    },
                },
                registration: {
                    binding: {
                        source: {
                            kind: "endpoint" as const,
                            resolve:
                                id === "source-fails"
                                    ? () => {
                                          throw new Error(
                                              "SOURCE_SECRET /private/provider/socket",
                                          );
                                      }
                                    : () => unavailableUpstream,
                        },
                    },
                    declaration: { id, title: id },
                    id,
                    pointId: "web.applications",
                },
            };
        },
    };
    const http = new HttpHost({ listenHost: "127.0.0.1", listenPort: 0 });
    const sessions = new ControlWebSessionService({
        auth: { mode: "none" },
        basePath: "/web",
    });
    const removeSessions = sessions.install(http);
    const removeGateway = new ExtensionWebGateway({
        basePath: "/web/extensions",
        extensions: extensions as never,
        loginPath: "/web/",
    }).install(http, sessions);

    try {
        await http.start();
        const address = http.address;
        assert.ok(typeof address === "object" && address !== null);
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const sessionResponse = await fetch(`${baseUrl}/web/session`, {
            method: "POST",
        });
        const cookie = sessionCookie(sessionResponse.headers.get("set-cookie"));

        const missing = await fetch(`${baseUrl}/web/extensions/missing/api`, {
            headers: { cookie },
        });
        assert.equal(missing.status, 404);
        assert.deepEqual(await missing.json(), {
            error: "Extension WebUI not found",
        });

        const activation = await fetch(
            `${baseUrl}/web/extensions/activation-fails/api`,
            { headers: { cookie } },
        );
        assert.equal(activation.status, 503);
        const activationBody = await activation.text();
        assert.equal(
            activationBody,
            JSON.stringify({ error: "Extension WebUI unavailable" }),
        );
        assert.doesNotMatch(
            activationBody,
            /ACTIVATION_SECRET|private\/generation/u,
        );

        const source = await fetch(
            `${baseUrl}/web/extensions/source-fails/api`,
            { headers: { cookie } },
        );
        assert.equal(source.status, 503);
        const sourceBody = await source.text();
        assert.equal(
            sourceBody,
            JSON.stringify({ error: "Extension WebUI unavailable" }),
        );
        assert.doesNotMatch(sourceBody, /SOURCE_SECRET|private\/provider/u);

        const upstream = await fetch(
            `${baseUrl}/web/extensions/upstream-fails/api`,
            { headers: { cookie } },
        );
        assert.equal(upstream.status, 502);
        const upstreamBody = await upstream.text();
        assert.equal(
            upstreamBody,
            JSON.stringify({ error: "Extension WebUI upstream failed" }),
        );
        assert.doesNotMatch(upstreamBody, /ECONNREFUSED|127\.0\.0\.1:\d+/u);

        const sourceUpgrade = await requestUpgradeFailure(
            `${baseUrl}/web/extensions/source-fails/socket`,
            cookie,
        );
        assert.equal(sourceUpgrade.statusCode, 503);
        assert.equal(sourceUpgrade.body, "Extension WebSocket unavailable\n");
        assert.doesNotMatch(
            sourceUpgrade.body,
            /SOURCE_SECRET|private\/provider/u,
        );

        const upstreamUpgrade = await requestUpgradeFailure(
            `${baseUrl}/web/extensions/upstream-fails/socket`,
            cookie,
        );
        assert.equal(upstreamUpgrade.statusCode, 502);
        assert.equal(
            upstreamUpgrade.body,
            "Extension WebSocket upstream failed\n",
        );
        assert.doesNotMatch(
            upstreamUpgrade.body,
            /ECONNREFUSED|127\.0\.0\.1:\d+/u,
        );

        assert.equal(leases, 0);
        assert.equal(releases, 4);
    } finally {
        removeGateway();
        removeSessions();
        await http.stop();
    }
});

function sessionCookie(setCookie: string | null): string {
    assert.ok(setCookie !== null);
    return setCookie.split(";", 1)[0]!;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for Extension Web lease release.");
}

async function openStreamingResponse(
    url: string,
    cookie: string,
): Promise<IncomingMessage> {
    return await new Promise<IncomingMessage>((resolve, reject) => {
        const request = httpRequest(
            url,
            { headers: { cookie } },
            (response) => {
                response.once("error", reject);
                response.once("data", () => {
                    response.pause();
                    resolve(response);
                });
            },
        );
        request.once("error", reject);
        request.end();
    });
}

async function unusedLoopbackUrl(): Promise<URL> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    const url = new URL(`http://127.0.0.1:${address.port}/`);
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    return url;
}

async function requestUpgradeFailure(
    url: string,
    cookie: string,
): Promise<{ body: string; statusCode: number }> {
    return await new Promise((resolve, reject) => {
        const request = httpRequest(url, {
            headers: {
                connection: "Upgrade",
                cookie,
                upgrade: "websocket",
            },
        });
        request.once("upgrade", (_response, socket) => {
            socket.destroy();
            reject(new Error("Expected Extension WebSocket upgrade to fail."));
        });
        request.once("response", (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("error", reject);
            response.once("end", () =>
                resolve({
                    body: Buffer.concat(chunks).toString("utf8"),
                    statusCode: response.statusCode ?? 0,
                }),
            );
        });
        request.once("error", reject);
        request.end();
    });
}
