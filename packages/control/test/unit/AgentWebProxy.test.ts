import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";

import { HttpHost } from "@portable-devshell/mcp/testing";
import type { AgentRecord } from "@portable-devshell/shared";
import { WebSocket, WebSocketServer } from "ws";

import { AgentWebProxy } from "../../src/server/web/agent/AgentWebProxy.ts";
import { ControlWebSessionService } from "../../src/server/web/ControlWebSessionService.ts";

test("Agent Web proxy authenticates by devshell session and strips credentials before loopback upstream", async () => {
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
        response.setHeader("set-cookie", "provider_secret=must-not-escape");
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
    const record: AgentRecord = {
        agentId: "ag-1",
        provider: "pi",
        providerVersion: "0.84.4",
        slug: "review",
        state: "running",
        target: { instance: "worker-a", workspace: "/repo" },
        web: {
            basePath: "/web/agent/review/",
            upstream: `http://127.0.0.1:${upstreamAddress.port}/`
        }
    };
    const http = new HttpHost({ listenHost: "127.0.0.1", listenPort: 0 });
    const sessions = new ControlWebSessionService({ auth: { mode: "none" }, basePath: "/web" });
    const removeSessionRoutes = sessions.install(http);
    const removeProxy = new AgentWebProxy({
        agent: { list: () => [record] },
        basePath: "/web/agent"
    }).install(http, sessions);

    try {
        await http.start();
        const address = http.address;
        assert.ok(typeof address === "object" && address !== null);
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const unauthorized = await fetch(`${baseUrl}/web/agent/review/api/state`);
        assert.equal(unauthorized.status, 401);
        assert.equal(observed.length, 0);

        const sessionResponse = await fetch(`${baseUrl}/web/session`, { method: "POST" });
        assert.equal(sessionResponse.status, 200);
        const cookie = sessionCookie(sessionResponse.headers.get("set-cookie"));

        const redirect = await fetch(`${baseUrl}/web/agent/review`, {
            headers: { cookie },
            redirect: "manual"
        });
        assert.equal(redirect.status, 308);
        assert.equal(redirect.headers.get("location"), "/web/agent/review/");

        const proxied = await fetch(`${baseUrl}/web/agent/review/api/state?view=full`, {
            headers: {
                authorization: "Bearer must-not-reach-provider",
                cookie
            }
        });
        assert.equal(proxied.status, 200);
        assert.equal(proxied.headers.get("set-cookie"), null);
        assert.deepEqual(await proxied.json(), { ok: true, path: "/api/state?view=full" });
        assert.deepEqual(observed.at(-1), {
            path: "/api/state?view=full",
            prefix: "/web/agent/review"
        });

        const echoed = await websocketRoundTrip(
            `ws://127.0.0.1:${address.port}/web/agent/review/socket?mode=live`,
            cookie
        );
        assert.equal(echoed, "echo:hello");
        assert.deepEqual(observedUpgrade, {
            path: "/socket?mode=live",
            prefix: "/web/agent/review"
        });
    } finally {
        removeProxy();
        removeSessionRoutes();
        await http.stop();
        upstreamWebSockets.close();
        await new Promise<void>((resolve, reject) => upstreamServer.close((error) => error ? reject(error) : resolve()));
    }
});

function sessionCookie(setCookie: string | null): string {
    assert.ok(setCookie !== null);
    return setCookie.split(";", 1)[0]!;
}

async function websocketRoundTrip(url: string, cookie: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(url, {
            headers: {
                authorization: "Bearer must-not-reach-provider",
                cookie
            }
        });
        socket.once("error", reject);
        socket.once("open", () => socket.send("hello"));
        socket.once("message", (message) => {
            resolve(message.toString());
            socket.close();
        });
    });
}
