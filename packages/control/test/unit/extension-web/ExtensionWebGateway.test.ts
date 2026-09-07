import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { HttpHost } from "@portable-devshell/mcp/testing";
import { WebSocket, WebSocketServer } from "ws";

import { ExtensionPathLayout } from "../../../src/control/extension/ExtensionPathLayout.ts";
import { ControlWebSessionService } from "../../../src/server/web/ControlWebSessionService.ts";
import { ExtensionWebGateway } from "../../../src/server/web/extension/ExtensionWebGateway.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

test("Extension Web proxy authenticates one generic namespace, strips credentials, and holds the generation lease through WebSocket close", async () => {
    const observed: Array<{
        authorization?: string;
        cookie?: string;
        path?: string;
        prefix?: string;
    }> = [];
    const upstreamServer = createServer((request, response) => {
        observed.push({
            ...(typeof request.headers.authorization === "string" ? { authorization: request.headers.authorization } : {}),
            ...(typeof request.headers.cookie === "string" ? { cookie: request.headers.cookie } : {}),
            path: request.url,
            ...(typeof request.headers["x-forwarded-prefix"] === "string"
                ? { prefix: request.headers["x-forwarded-prefix"] }
                : {})
        });
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.setHeader("set-cookie", "extension_secret=must-not-escape");
        response.end(JSON.stringify({ ok: true, path: request.url }));
    });
    const upstreamWebSockets = new WebSocketServer({ server: upstreamServer });
    let observedUpgrade: {
        authorization?: string;
        cookie?: string;
        path?: string;
        prefix?: string;
    } | undefined;
    upstreamWebSockets.on("connection", (socket, request) => {
        observedUpgrade = {
            ...(typeof request.headers.authorization === "string" ? { authorization: request.headers.authorization } : {}),
            ...(typeof request.headers.cookie === "string" ? { cookie: request.headers.cookie } : {}),
            path: request.url,
            ...(typeof request.headers["x-forwarded-prefix"] === "string"
                ? { prefix: request.headers["x-forwarded-prefix"] }
                : {})
        };
        socket.on("message", (message) => socket.send(`echo:${message.toString()}`));
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
        acquire(id: string) {
            assert.equal(id, "example");
            leases += 1;
            let released = false;
            return {
                activation: {
                    web: {
                        kind: "proxy" as const,
                        resolveUpstream: () => upstream
                    }
                },
                generation: "g1",
                release() {
                    if (released) return;
                    released = true;
                    leases -= 1;
                    releases += 1;
                }
            };
        }
    };
    const http = new HttpHost({ listenHost: "127.0.0.1", listenPort: 0 });
    const sessions = new ControlWebSessionService({ auth: { mode: "none" }, basePath: "/web" });
    const removeSessionRoutes = sessions.install(http);
    const removeGateway = new ExtensionWebGateway({
        basePath: "/web/extensions",
        extensions: extensions as never,
        loginPath: "/web/",
        paths: {} as never
    }).install(http, sessions);

    try {
        await http.start();
        const address = http.address;
        assert.ok(typeof address === "object" && address !== null);
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const entry = await fetch(`${baseUrl}/web/extensions/example/?view=one`, { redirect: "manual" });
        assert.equal(entry.status, 302);
        const login = new URL(entry.headers.get("location")!, baseUrl);
        assert.equal(login.pathname, "/web/");
        assert.equal(login.searchParams.get("returnTo"), "/web/extensions/example/?view=one");
        assert.equal(leases, 0);

        const unauthorized = await fetch(`${baseUrl}/web/extensions/example/api/sessions`);
        assert.equal(unauthorized.status, 401);
        assert.equal(leases, 0);

        const sessionResponse = await fetch(`${baseUrl}/web/session`, { method: "POST" });
        assert.equal(sessionResponse.status, 200);
        const cookie = sessionCookie(sessionResponse.headers.get("set-cookie"));

        const proxied = await fetch(`${baseUrl}/web/extensions/example/api/sessions?view=full`, {
            headers: {
                authorization: "Bearer must-not-reach-extension",
                cookie
            }
        });
        assert.equal(proxied.status, 200);
        assert.equal(proxied.headers.get("set-cookie"), null);
        assert.deepEqual(await proxied.json(), { ok: true, path: "/api/sessions?view=full" });
        assert.deepEqual(observed.at(-1), {
            path: "/api/sessions?view=full",
            prefix: "/web/extensions/example"
        });
        assert.equal(leases, 0);
        assert.equal(releases, 1);

        const socket = new WebSocket(
            `ws://127.0.0.1:${address.port}/web/extensions/example/socket?mode=live`,
            { headers: { authorization: "Bearer must-not-reach-extension", cookie } }
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
            prefix: "/web/extensions/example"
        });
        assert.equal(leases, 1);
        const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
        socket.close();
        await closed;
        await waitFor(() => leases === 0);
        assert.equal(releases, 2);
    } finally {
        removeGateway();
        removeSessionRoutes();
        await http.stop();
        upstreamWebSockets.close();
        await new Promise<void>((resolve, reject) => upstreamServer.close((error) => error ? reject(error) : resolve()));
    }
});

test("Extension static Web contribution serves only files contained by the immutable generation", async (t) => {
    const root = await createTestTempDirectory("extension-web-static");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const paths = new ExtensionPathLayout({
        dataHome: join(root, "data"),
        homeDirectory: join(root, "home"),
        runtimeRoot: join(root, "runtime")
    });
    const codeDirectory = paths.generationDirectory("example", "g1");
    await mkdir(join(codeDirectory, "web", "assets"), { recursive: true });
    await writeFile(join(codeDirectory, "web", "index.html"), "<main>extension</main>\n", "utf8");
    await writeFile(join(codeDirectory, "web", "assets", "app.js"), "console.log('extension');\n", "utf8");
    await writeFile(join(codeDirectory, "outside.txt"), "not web\n", "utf8");
    let leases = 0;
    const extensions = {
        acquire(id: string) {
            assert.equal(id, "example");
            leases += 1;
            let released = false;
            return {
                activation: { web: { directory: "web", kind: "static" as const } },
                generation: "g1",
                release() {
                    if (released) return;
                    released = true;
                    leases -= 1;
                }
            };
        }
    };
    const http = new HttpHost({ listenHost: "127.0.0.1", listenPort: 0 });
    const sessions = new ControlWebSessionService({ auth: { mode: "none" }, basePath: "/web" });
    const removeSessions = sessions.install(http);
    const removeGateway = new ExtensionWebGateway({
        basePath: "/web/extensions",
        extensions: extensions as never,
        loginPath: "/web/",
        paths
    }).install(http, sessions);
    try {
        await http.start();
        const address = http.address;
        assert.ok(typeof address === "object" && address !== null);
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const sessionResponse = await fetch(`${baseUrl}/web/session`, { method: "POST" });
        const cookie = sessionCookie(sessionResponse.headers.get("set-cookie"));

        const index = await fetch(`${baseUrl}/web/extensions/example/`, { headers: { cookie } });
        assert.equal(index.status, 200);
        assert.equal(await index.text(), "<main>extension</main>\n");
        assert.match(index.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
        assert.equal(index.headers.get("cache-control"), "no-cache");

        const asset = await fetch(`${baseUrl}/web/extensions/example/assets/app.js`, { headers: { cookie } });
        assert.equal(asset.status, 200);
        assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

        const escape = await fetch(`${baseUrl}/web/extensions/example/%2e%2e/outside.txt`, { headers: { cookie } });
        assert.equal(escape.status, 404);
        assert.equal(leases, 0);
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
