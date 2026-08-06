import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { HttpHost, McpOAuthProtectedResource, type McpOAuthApprovalService } from "@portable-devshell/mcp";
import { McpHost } from "@portable-devshell/mcp/testing";
import {
    ClientConnection,
    CONTROL_PROTOCOL_VERSION,
    PrefixRoute,
    controlWebBasePath,
    createError,
    type JsonValue,
    type PrefixRouteSnapshot
} from "@portable-devshell/shared";

import { ControlChannelServer } from "../../src/server/channel/ControlChannelServer.ts";
import { negotiateControlProtocol } from "../../src/control/service/ServiceRouteModule.ts";
import { ControlWebOAuthFlow } from "../../src/server/web/ControlWebOAuthFlow.ts";
import { ControlWebSessionService } from "../../src/server/web/ControlWebSessionService.ts";
import { ControlWebSocketListener } from "../../src/server/web/ControlWebSocketListener.ts";
import { NodeWebSocketChannel } from "../WebSocketTestSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const WEB_RESOURCE_NAME = "demo-web";
const WEB_SCOPES = ["web"];

test("web oauth2 completes browser PKCE and authenticates the real control WebSocket", async (t) => {
    const port = await reservePort();
    const publicBaseUrl = `http://127.0.0.1:${port}`;
    const storage = await createTestTempDirectory("web-oauth");
    const protectedResource = new McpOAuthProtectedResource(
        { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME },
        publicBaseUrl,
        storage,
        { trustProxy: true }
    );
    const http = new HttpHost({ listenHost: "127.0.0.1", listenPort: port });
    const sessions = new ControlWebSessionService({
        auth: { mode: "oauth2", oauth2: { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME } },
        basePath: "/web"
    });
    const flow = new ControlWebOAuthFlow({
        basePath: "/web",
        config: { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME },
        ownsProvider: true,
        protectedResource,
        publicBaseUrl,
        sessions
    });
    const uninstall = flow.install(http);
    const channels = new ControlChannelServer({
        listeners: [new ControlWebSocketListener({ http, sessions })],
        routes: { connectionClosed() {}, snapshot: createRouteSnapshot }
    });
    http.installOAuth(protectedResource);
    await flow.warmup();
    await channels.start();
    await http.start();
    t.after(async () => {
        await channels.close().catch(() => undefined);
        uninstall();
        await http.stop().catch(() => undefined);
        await rm(storage, { force: true, recursive: true });
    });

    const metadata = await fetch(`${publicBaseUrl}/.well-known/oauth-protected-resource/web`);
    assert.equal(metadata.status, 200);
    const metadataBody = await metadata.json() as { authorization_servers: string[]; resource: string; resource_name: string };
    assert.equal(metadataBody.resource, `${publicBaseUrl}/web`);
    assert.equal(metadataBody.resource_name, WEB_RESOURCE_NAME);
    assert.deepEqual(metadataBody.authorization_servers, [publicBaseUrl]);

    assert.equal((await fetch(`${publicBaseUrl}/web/session`, { method: "POST" })).status, 401);

    const sessionCookie = await walkBrowserFlow(publicBaseUrl, protectedResource.approvals);
    assert.notEqual(sessionCookie, undefined);
    assert.deepEqual(
        (await protectedResource.approvals.list()).map((approval) => approval.kind).sort(),
        ["authorization", "registration"]
    );
    assert.match(sessionCookie!, /devshell_web_session=/u);

    const authenticated = await fetch(`${publicBaseUrl}/web/session`, {
        headers: { cookie: sessionCookie! }
    });
    assert.equal(authenticated.status, 200);

    const connection = new ClientConnection({
        connectChannel: async () =>
            await NodeWebSocketChannel.connect(
                `${publicBaseUrl.replace("http", "ws")}/web/rpc`,
                sessionCookie!
            ),
        mapError: (error) => error instanceof Error ? error : new Error(String(error)),
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "web"
    });
    t.after(() => connection.close());
    await connection.request("@control", "service", "hello", {
        clientKind: "web",
        maxProtocolVersion: CONTROL_PROTOCOL_VERSION,
        minProtocolVersion: CONTROL_PROTOCOL_VERSION,
    });
    assert.deepEqual(
        await connection.request<JsonValue>("@control", "service", "ping"),
        { pong: true }
    );
});

test("web oauth2 rejects a callback whose state cookie does not match", async (t) => {
    const port = await reservePort();
    const publicBaseUrl = `http://127.0.0.1:${port}`;
    const storage = await createTestTempDirectory("web-oauth-csrf");
    const protectedResource = new McpOAuthProtectedResource(
        { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME },
        publicBaseUrl,
        storage,
        { trustProxy: true }
    );
    const http = new HttpHost({ listenHost: "127.0.0.1", listenPort: port });
    const sessions = new ControlWebSessionService({
        auth: { mode: "oauth2", oauth2: { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME } },
        basePath: "/web"
    });
    const flow = new ControlWebOAuthFlow({
        basePath: "/web",
        config: { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME },
        ownsProvider: true,
        protectedResource,
        publicBaseUrl,
        sessions
    });
    const uninstall = flow.install(http);
    http.installOAuth(protectedResource);
    await flow.warmup();
    await http.start();
    t.after(async () => {
        uninstall();
        await http.stop().catch(() => undefined);
        await rm(storage, { force: true, recursive: true });
    });

    const forged = await fetch(`${publicBaseUrl}/web/oauth/callback?code=abc&state=forged`, {
        redirect: "manual"
    });
    assert.equal(forged.status, 400);
});

test("web oauth2 reuses its persisted dynamic client after a control restart", async (t) => {
    const port = await reservePort();
    const publicBaseUrl = `http://127.0.0.1:${port}`;
    const storage = await createTestTempDirectory("web-oauth-client-state");
    const clientStateFile = join(storage, "web-client.json");
    t.after(async () => await rm(storage, { force: true, recursive: true }));

    const startRuntime = async () => {
        const protectedResource = new McpOAuthProtectedResource(
            { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME },
            publicBaseUrl,
            storage,
            { trustProxy: true }
        );
        const http = new HttpHost({ listenHost: "127.0.0.1", listenPort: port });
        const sessions = new ControlWebSessionService({
            auth: { mode: "oauth2", oauth2: { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME } },
            basePath: "/web"
        });
        const flow = new ControlWebOAuthFlow({
            basePath: "/web",
            clientStateFile,
            config: { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME },
            ownsProvider: true,
            protectedResource,
            publicBaseUrl,
            sessions
        });
        http.installOAuth(protectedResource);
        flow.install(http);
        await flow.warmup();
        await http.start();
        return { http, protectedResource };
    };

    const first = await startRuntime();
    const firstStart = await fetch(`${publicBaseUrl}/web/oauth/start`, { redirect: "manual" });
    assert.equal(firstStart.status, 302);
    await waitFor(async () =>
        (await first.protectedResource.approvals.list()).filter((approval) => approval.kind === "registration").length === 1
    );
    const firstRegistration = (await first.protectedResource.approvals.list()).find(
        (approval) => approval.kind === "registration"
    );
    assert.notEqual(firstRegistration, undefined);
    await first.http.stop();

    const second = await startRuntime();
    t.after(async () => await second.http.stop().catch(() => undefined));
    const secondStart = await fetch(`${publicBaseUrl}/web/oauth/start`, { redirect: "manual" });
    assert.equal(secondStart.status, 302);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const registrations = (await second.protectedResource.approvals.list()).filter(
        (approval) => approval.kind === "registration"
    );
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0]?.clientId, firstRegistration?.clientId);
});

test("web oauth2 shares one provider with MCP on a shared listener without route conflicts", async (t) => {
    const port = await reservePort();
    const publicBaseUrl = `http://127.0.0.1:${port}`;
    const storage = await createTestTempDirectory("web-oauth-shared");
    const host = new McpHost({
        instances: [{
            auth: {
                enabled: true,
                oauth2: { requiredScopes: ["mcp"], resourceName: "demo-mcp" },
                provider: "oauth2"
            },
            name: "demo",
            policy: { capabilities: ["execute"], groups: ["bash"] },
            worker: createMcpWorker()
        }],
        listenHost: "127.0.0.1",
        listenPort: port,
        publicBaseUrl,
        storageDir: storage
    });
    const protectedResource = host.oauthProtectedResource;
    assert.notEqual(protectedResource, undefined);

    const sessions = new ControlWebSessionService({
        auth: { mode: "oauth2", oauth2: { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME } },
        basePath: "/web"
    });
    const flow = new ControlWebOAuthFlow({
        basePath: "/web",
        config: { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME },
        ownsProvider: false,
        protectedResource: protectedResource!,
        publicBaseUrl,
        sessions
    });
    const uninstall = flow.install(host.server);
    const uninstallSession = sessions.install(host.server);
    await flow.warmup();
    await host.start();
    t.after(async () => {
        uninstall();
        uninstallSession();
        await host.stop().catch(() => undefined);
        await rm(storage, { force: true, recursive: true });
    });

    const webMetadata = await (await fetch(`${publicBaseUrl}/.well-known/oauth-protected-resource/web`)).json() as { resource: string };
    assert.equal(webMetadata.resource, `${publicBaseUrl}/web`);
    const mcpMetadata = await (await fetch(`${publicBaseUrl}/.well-known/oauth-protected-resource/demo/mcp`)).json() as { resource: string };
    assert.equal(mcpMetadata.resource, `${publicBaseUrl}/demo/mcp`);

    const sessionCookie = await walkBrowserFlow(publicBaseUrl, protectedResource!.approvals);
    assert.notEqual(sessionCookie, undefined);
    assert.equal((await fetch(`${publicBaseUrl}/web/session`, { headers: { cookie: sessionCookie! } })).status, 200);

    assert.equal((await fetch(`${publicBaseUrl}/demo/mcp`, { method: "POST" })).status, 401);
});

test("web oauth2 preserves a public URL path prefix across discovery, PKCE, and redirect", async (t) => {
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const publicBaseUrl = `${origin}/devshell`;
    const basePath = controlWebBasePath(publicBaseUrl);
    const storage = await createTestTempDirectory("web-oauth-prefix");
    const protectedResource = new McpOAuthProtectedResource(
        { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME },
        origin,
        storage,
        { trustProxy: true }
    );
    const http = new HttpHost({ listenHost: "127.0.0.1", listenPort: port });
    const sessions = new ControlWebSessionService({
        auth: { mode: "oauth2", oauth2: { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME } },
        basePath
    });
    const flow = new ControlWebOAuthFlow({
        basePath,
        config: { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME },
        ownsProvider: true,
        protectedResource,
        publicBaseUrl,
        sessions
    });
    await flow.warmup();
    const uninstall = flow.install(http);
    const uninstallSession = sessions.install(http);
    await http.start();
    t.after(async () => {
        uninstall();
        uninstallSession();
        await http.stop().catch(() => undefined);
        await rm(storage, { force: true, recursive: true });
    });

    const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource${basePath}`);
    assert.equal(metadata.status, 200);
    const metadataBody = await metadata.json() as { authorization_servers: string[]; resource: string };
    assert.equal(metadataBody.resource, `${origin}${basePath}`);
    assert.deepEqual(metadataBody.authorization_servers, [origin]);

    const sessionCookie = await walkBrowserFlow(origin, protectedResource.approvals, basePath);
    assert.notEqual(sessionCookie, undefined);
    const authenticated = await fetch(`${origin}${basePath}/session`, {
        headers: { cookie: sessionCookie! }
    });
    assert.equal(authenticated.status, 200);
});

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

async function walkBrowserFlow(
    origin: string,
    approvals: McpOAuthApprovalService,
    basePath = "/web"
): Promise<string | undefined> {
    let cookieHeader = "";
    const start = await fetch(`${origin}${basePath}/oauth/start`, { redirect: "manual" });
    assert.equal(start.status, 302);
    cookieHeader = mergeCookieHeader(cookieHeader, start);
    assert.match(start.headers.get("set-cookie") ?? "", /devshell_web_oauth_state=/u);

    let currentUrl = new URL(start.headers.get("location")!, origin).href;
    let method: "GET" | "POST" = "GET";
    let approvalKind: "authorization" | "registration" = "registration";

    for (let step = 0; step < 12; step += 1) {
        const response = await fetch(currentUrl, {
            body: method === "POST" ? new URLSearchParams({ submit: "1" }).toString() : undefined,
            headers: {
                ...(cookieHeader.length === 0 ? {} : { cookie: cookieHeader }),
                ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {})
            },
            method,
            redirect: "manual"
        });
        cookieHeader = mergeCookieHeader(cookieHeader, response);

        if (response.status === 200) {
            const html = await response.text();
            if (html.includes("window.location.reload()")) {
                await approvePending(approvals, approvalKind);
                if (approvalKind === "registration") approvalKind = "authorization";
                method = "GET";
                continue;
            }
            if (!html.includes("Administrator approved this request.")) {
                await approvePending(approvals, approvalKind);
            }
            method = "POST";
            continue;
        }

        const location = response.headers.get("location");
        assert.notEqual(location, null);
        const nextUrl = new URL(location!, currentUrl);
        if (nextUrl.pathname === `${basePath}/oauth/callback`) {
            const callback = await fetch(nextUrl.href, {
                headers: { cookie: cookieHeader },
                redirect: "manual"
            });
            cookieHeader = mergeCookieHeader(cookieHeader, callback);
            const callbackBody = await callback.text();
            assert.equal(callback.status, 302, callbackBody);
            assert.equal(new URL(callback.headers.get("location")!, origin).pathname, `${basePath}/`);
            return extractCookie(cookieHeader, "devshell_web_session");
        }
        currentUrl = nextUrl.href;
        method = "GET";
    }

    throw new Error("web oauth2 browser flow did not complete");
}

async function approvePending(approvals: McpOAuthApprovalService, kind: "authorization" | "registration"): Promise<void> {
    const approval = (await approvals.list()).find((candidate) => candidate.kind === kind && candidate.status === "pending");
    assert.notEqual(approval, undefined, `pending ${kind} approval was not created`);
    await approvals.decide(approval!.approvalId, "approve", "tui");
}

function extractCookie(header: string, name: string): string | undefined {
    for (const part of header.split(/;\s*/u)) {
        const [key, value] = part.split("=", 2);
        if (key === name && value !== undefined) {
            return `${name}=${value}`;
        }
    }
    return undefined;
}

function mergeCookieHeader(existing: string, response: Response): string {
    const nextEntries = readSetCookieEntries(response);
    if (nextEntries.length === 0) {
        return existing;
    }
    const cookies = new Map<string, string>();
    for (const entry of existing.split(/;\s*/u).filter((part) => part.length > 0)) {
        const [name, value] = entry.split("=", 2);
        if (name !== undefined && value !== undefined) cookies.set(name, value);
    }
    for (const header of nextEntries) {
        const [pair] = header.split(";", 1);
        const [name, value] = pair.split("=", 2);
        if (name !== undefined && value !== undefined) cookies.set(name, value);
    }
    return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function readSetCookieEntries(response: Response): string[] {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    if (typeof headers.getSetCookie === "function") {
        return headers.getSetCookie();
    }
    const header = response.headers.get("set-cookie");
    return header === null ? [] : [header];
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("condition was not met before timeout");
}

async function reservePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo | null;
    if (address === null) throw new Error("Port reservation failed.");
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    return address.port;
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
                        { name: "ping", handle: () => ({ pong: true }) }
                    ]
                }
            ]
        }
    ]);
}
