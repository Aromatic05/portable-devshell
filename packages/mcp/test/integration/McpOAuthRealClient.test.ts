import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { requireTcpPort } from "../../../../test/TestHttpSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { realWorkerTestOptions, resolveTestWorkerBinary } from "../../../../test/TestPlatformSupport.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
    auth,
    discoverOAuthServerInfo,
    refreshAuthorization,
    UnauthorizedError
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { asInstanceName, asWorkspacePath } from "@portable-devshell/shared";
import { WorkerBinary, WorkerInstanceFactory, WorkerTransportDriverLocal } from "@portable-devshell/core/testing";
import { McpHost } from "@portable-devshell/mcp/testing";
import type { McpAuthConfig } from "@portable-devshell/mcp";

const workerBinaryPath = resolveTestWorkerBinary();
const clientInfo = { name: "portable-devshell-real-client", version: "0.0.0" };

test("a real MCP SDK client drives a none-auth frozen worker through initialize, tools/list and tools/call", realWorkerTestOptions(workerBinaryPath), async () => {
    const { cleanupDirs, host, instance, workspaceMarker } = await startFrozenWorkerHost("real-none", {
        enabled: false,
        provider: "none"
    });

    try {
        const endpoint = endpointFor(host, "real-none");
        const client = new Client(clientInfo);
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

        assert.equal(client.getServerVersion()?.name !== undefined, true);
        const tools = await client.listTools();
        assert.equal(tools.tools.some((tool) => tool.name === "bash_run"), true);

        const ctxId = await readContextId(client);
        const result = await client.callTool({
            arguments: { command: `cat -- './${workspaceMarker.name}'`, ctxId },
            name: "bash_run"
        });
        assert.equal(result.isError, false);
        assert.match(
            String((result.structuredContent as { stdout?: string } | undefined)?.stdout ?? ""),
            new RegExp(workspaceMarker.value, "u")
        );
        assert.equal(
            (await instance.readToolCalls()).some((record) => record.source === "mcp" && record.status === "completed"),
            true
        );
        await client.close();
    } finally {
        await teardownFrozenWorker(host, instance, cleanupDirs);
    }
});

test("a real MCP SDK client authenticates to a token-auth frozen worker with a bearer header", realWorkerTestOptions(workerBinaryPath), async () => {
    const staticToken = "real-token-client-secret-value-0123456789ab";
    const { cleanupDirs, host, instance, workspaceMarker } = await startFrozenWorkerHost("real-token", {
        enabled: true,
        provider: "token",
        token: staticToken
    });

    try {
        const endpoint = endpointFor(host, "real-token");

        const anonymous = new Client(clientInfo);
        await assert.rejects(
            anonymous.connect(new StreamableHTTPClientTransport(new URL(endpoint))),
            (error: unknown) => error instanceof UnauthorizedError || /401|unauthorized/iu.test(String(error))
        );

        const client = new Client(clientInfo);
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
            requestInit: { headers: { authorization: `Bearer ${staticToken}` } }
        }));

        const tools = await client.listTools();
        assert.equal(tools.tools.some((tool) => tool.name === "bash_run"), true);

        const ctxId = await readContextId(client);
        const result = await client.callTool({
            arguments: { command: `cat -- './${workspaceMarker.name}'`, ctxId },
            name: "bash_run"
        });
        assert.equal(result.isError, false);
        assert.match(
            String((result.structuredContent as { stdout?: string } | undefined)?.stdout ?? ""),
            new RegExp(workspaceMarker.value, "u")
        );
        await client.close();
    } finally {
        await teardownFrozenWorker(host, instance, cleanupDirs);
    }
});

test("a real MCP SDK OAuth consumer completes registration, PKCE authorization, approval, token exchange, refresh, revocation and tools/call against a frozen worker", realWorkerTestOptions(workerBinaryPath), async () => {
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const storageDir = await createTestTempDirectory("mcp-oauth-real-client");
    const workspacePath = await createTestTempDirectory("mcp-oauth-real-workspace");
    const homeDirectory = await createTestTempDirectory("mcp-oauth-real-home");
    const markerName = "oauth-real-marker.txt";
    const markerValue = "oauth-real-frozen-worker";
    await writeFile(join(workspacePath, markerName), markerValue, "utf8");

    const instance = createFrozenWorker("real-oauth", homeDirectory, workspacePath);
    const host = new McpHost({
        instances: [
            {
                auth: {
                    enabled: true,
                    oauth2: {
                        documentationUrl: "https://docs.example.com/aromatic",
                        requiredScopes: ["mcp"],
                        resourceName: "aromatic"
                    },
                    provider: "oauth2"
                },
                name: "real-oauth",
                policy: { capabilities: ["execute"], groups: ["bash"] },
                worker: instance
            }
        ],
        listenHost: "127.0.0.1",
        listenPort: port,
        publicBaseUrl: origin,
        storageDir
    });

    try {
        await instance.start();
        await host.start();

        const endpoint = `${origin}/real-oauth/mcp`;
        const approvals = host.oauthApprovals;
        assert.notEqual(approvals, undefined);

        const provider = new InMemoryOAuthClientProvider();

        const anonymous = new Client(clientInfo);
        await assert.rejects(
            anonymous.connect(new StreamableHTTPClientTransport(new URL(endpoint), { authProvider: provider })),
            (error: unknown) => error instanceof UnauthorizedError || /unauthorized/iu.test(String(error))
        );

        assert.notEqual(provider.clientInformation(), undefined, "SDK consumer performed dynamic client registration");
        assert.equal(
            (await approvals!.list()).some((request) => request.kind === "registration" && request.status === "pending"),
            true,
            "dynamic client registration created a real registration approval"
        );

        const scope = "mcp offline_access";
        assert.equal(await auth(provider, { scope, serverUrl: endpoint }), "REDIRECT");
        const authorizationUrl = provider.lastAuthorizationUrl!;
        assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
        assert.notEqual(authorizationUrl.searchParams.get("code_challenge"), null);
        assert.match(` ${authorizationUrl.searchParams.get("scope") ?? ""} `, /offline_access/u);

        const code = await completeAuthorizationInBrowser(
            authorizationUrl,
            provider.redirectUrl,
            async () => {
                const pending = await waitForPendingApproval(approvals!);
                await approvals!.decide(pending.approvalId, "approve", "tui");
                return pending.kind;
            }
        );

        const decidedKinds = (await approvals!.list()).map((request) => request.kind).sort();
        assert.deepEqual(decidedKinds, ["authorization", "registration"]);

        assert.equal(await auth(provider, { authorizationCode: code, scope, serverUrl: endpoint }), "AUTHORIZED");
        const tokens = provider.tokens();
        assert.equal(typeof tokens?.access_token, "string");
        assert.equal(typeof tokens?.refresh_token, "string");

        const client = new Client(clientInfo);
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { authProvider: provider }));
        const tools = await client.listTools();
        assert.equal(tools.tools.some((tool) => tool.name === "bash_run"), true);
        const ctxId = await readContextId(client);
        const result = await client.callTool({
            arguments: { command: `cat -- './${markerName}'`, ctxId },
            name: "bash_run"
        });
        assert.equal(result.isError, false);
        assert.match(
            String((result.structuredContent as { stdout?: string } | undefined)?.stdout ?? ""),
            new RegExp(markerValue, "u")
        );
        await client.close();

        const serverInfo = await discoverOAuthServerInfo(endpoint);
        const metadata = serverInfo.authorizationServerMetadata;
        assert.notEqual(metadata, undefined);
        const clientInformation = provider.clientInformation()!;

        const refreshed = await refreshAuthorization(serverInfo.authorizationServerUrl, {
            clientInformation,
            metadata,
            refreshToken: tokens!.refresh_token!,
            resource: new URL(endpoint)
        });
        assert.equal(typeof refreshed.access_token, "string");
        assert.equal(typeof refreshed.refresh_token, "string");
        assert.notEqual(refreshed.refresh_token, tokens!.refresh_token);

        await assert.rejects(
            refreshAuthorization(serverInfo.authorizationServerUrl, {
                clientInformation,
                metadata,
                refreshToken: tokens!.refresh_token!,
                resource: new URL(endpoint)
            }),
            /invalid_grant|invalid|revoked/iu,
            "replaying a rotated refresh token must fail"
        );

        const revocationEndpoint = (metadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
        assert.equal(typeof revocationEndpoint, "string");
        const revoked = await fetch(revocationEndpoint!, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: clientInformation.client_id,
                token: refreshed.refresh_token!,
                token_type_hint: "refresh_token"
            })
        });
        assert.equal(revoked.status, 200);

        await assert.rejects(
            refreshAuthorization(serverInfo.authorizationServerUrl, {
                clientInformation,
                metadata,
                refreshToken: refreshed.refresh_token!,
                resource: new URL(endpoint)
            }),
            /invalid_grant|invalid|revoked/iu,
            "refreshing with a revoked refresh token must fail"
        );

        const afterRevocation = new Client(clientInfo);
        await assert.rejects(
            afterRevocation.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
                authProvider: new RevokedTokenProvider(provider, refreshed.access_token)
            })),
            (error: unknown) => error instanceof UnauthorizedError || /unauthorized/iu.test(String(error)),
            "an access token tied to a revoked grant must no longer open a session"
        );
    } finally {
        await teardownFrozenWorker(host, instance);
        await rm(storageDir, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

class InMemoryOAuthClientProvider implements OAuthClientProvider {
    readonly redirectUrl = "http://127.0.0.1:33418/callback";
    readonly clientMetadata: OAuthClientMetadata = {
        client_name: "Portable Devshell Real MCP Client",
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: ["http://127.0.0.1:33418/callback"],
        response_types: ["code"],
        scope: "mcp offline_access",
        token_endpoint_auth_method: "none"
    };
    #clientInformation?: OAuthClientInformationMixed;
    #codeVerifier?: string;
    #tokens?: OAuthTokens;
    lastAuthorizationUrl?: URL;

    clientInformation(): OAuthClientInformationMixed | undefined {
        return this.#clientInformation;
    }

    saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
        this.#clientInformation = clientInformation;
    }

    tokens(): OAuthTokens | undefined {
        return this.#tokens;
    }

    saveTokens(tokens: OAuthTokens): void {
        this.#tokens = tokens;
    }

    redirectToAuthorization(authorizationUrl: URL): void {
        this.lastAuthorizationUrl = authorizationUrl;
    }

    saveCodeVerifier(codeVerifier: string): void {
        this.#codeVerifier = codeVerifier;
    }

    codeVerifier(): string {
        if (this.#codeVerifier === undefined) {
            throw new Error("no PKCE code verifier was saved");
        }
        return this.#codeVerifier;
    }

    invalidateCredentials(scope: "all" | "client" | "discovery" | "tokens" | "verifier"): void {
        if (scope === "all" || scope === "tokens") this.#tokens = undefined;
        if (scope === "all" || scope === "client") this.#clientInformation = undefined;
        if (scope === "all" || scope === "verifier") this.#codeVerifier = undefined;
    }
}

class RevokedTokenProvider implements OAuthClientProvider {
    redirectUrl = "http://127.0.0.1:33418/callback";
    clientMetadata: OAuthClientMetadata;

    constructor(
        private readonly source: InMemoryOAuthClientProvider,
        private readonly accessToken: string
    ) {
        this.clientMetadata = source.clientMetadata;
    }

    clientInformation(): OAuthClientInformationMixed | undefined {
        return this.source.clientInformation();
    }

    tokens(): OAuthTokens {
        return { access_token: this.accessToken, token_type: "Bearer" };
    }

    saveTokens(): void {}

    redirectToAuthorization(): void {}

    saveCodeVerifier(): void {}

    codeVerifier(): string {
        throw new Error("no verifier");
    }
}

interface ApprovalServiceLike {
    decide(approvalId: string, decision: "approve" | "deny", decidedBy: "cli" | "tui" | "web"): Promise<unknown>;
    list(): Promise<Array<{ approvalId: string; kind: "authorization" | "registration"; status: string }>>;
}

async function waitForPendingApproval(approvals: ApprovalServiceLike) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const pending = (await approvals.list()).find((request) => request.status === "pending");
        if (pending !== undefined) {
            return pending;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("timed out waiting for a pending OAuth approval");
}

async function completeAuthorizationInBrowser(
    authorizationUrl: URL,
    redirectUri: string,
    approvePending: () => Promise<"authorization" | "registration">
): Promise<string> {
    let currentUrl = authorizationUrl.href;
    let method: "GET" | "POST" = "GET";
    let cookieHeader = "";

    for (let step = 0; step < 12; step += 1) {
        const response = await fetch(currentUrl, {
            method,
            headers: {
                ...(cookieHeader.length === 0 ? {} : { cookie: cookieHeader }),
                ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {})
            },
            body: method === "POST" ? new URLSearchParams({ submit: "1" }).toString() : undefined,
            redirect: "manual"
        });

        cookieHeader = mergeCookieHeader(cookieHeader, response);

        if (response.status >= 300 && response.status < 400) {
            const locationHeader = response.headers.get("location");
            assert.notEqual(locationHeader, null);
            const nextUrl = new URL(locationHeader!, currentUrl);
            if (`${nextUrl.origin}${nextUrl.pathname}` === redirectUri) {
                const code = nextUrl.searchParams.get("code");
                assert.notEqual(code, null);
                return code!;
            }
            currentUrl = nextUrl.href;
            method = "GET";
            continue;
        }

        if (response.status === 200) {
            const html = await response.text();
            if (html.includes("Administrator approved this request.")) {
                method = "POST";
                continue;
            }
            const kind = await approvePending();
            method = kind === "registration" ? "GET" : "POST";
            continue;
        }

        if (response.status === 409) {
            const kind = await approvePending();
            method = kind === "registration" ? "GET" : "POST";
            continue;
        }

        throw new Error(`unexpected authorization interaction status ${response.status}`);
    }

    throw new Error("authorization flow did not complete");
}

function mergeCookieHeader(existing: string, response: Response): string {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const nextEntries = typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : (response.headers.get("set-cookie") === null ? [] : [response.headers.get("set-cookie")!]);
    if (nextEntries.length === 0) {
        return existing;
    }

    const cookies = new Map<string, string>();
    for (const entry of existing.split(/;\s*/u).filter((part) => part.length > 0)) {
        const [name, value] = entry.split("=", 2);
        if (name !== undefined && value !== undefined) {
            cookies.set(name, value);
        }
    }
    for (const header of nextEntries) {
        const [pair] = header.split(";", 1);
        const [name, value] = pair.split("=", 2);
        if (name !== undefined && value !== undefined) {
            cookies.set(name, value);
        }
    }
    return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function readContextId(client: Client): Promise<string> {
    const environment = await client.callTool({ arguments: {}, name: "environ_info" });
    const ctxId = (environment.structuredContent as { ctxId?: string } | undefined)?.ctxId;
    assert.equal(typeof ctxId, "string");
    return ctxId!;
}

function endpointFor(host: McpHost, name: string): string {
    const port = requireTcpPort(host.server.address);
    return `http://127.0.0.1:${port}/${name}/mcp`;
}

function createFrozenWorker(name: string, homeDirectory: string, workspacePath: string) {
    return new WorkerInstanceFactory().create({
        defaultWorkspace: asWorkspacePath(workspacePath),
        env: { ...process.env, HOME: homeDirectory },
        homeDirectory,
        name: asInstanceName(name),
        transport: new WorkerTransportDriverLocal({
            spawnFunction: nodeSpawn,
            workerBinary: new WorkerBinary(workerBinaryPath!)
        })
    });
}

async function startFrozenWorkerHost(name: string, auth: McpAuthConfig) {
    const homeDirectory = await createTestTempDirectory(`mcp-real-${name}-home`);
    const workspacePath = await createTestTempDirectory(`mcp-real-${name}-workspace`);
    const markerName = `real-${name}-marker.txt`;
    const markerValue = `real-${name}-frozen-worker`;
    await writeFile(join(workspacePath, markerName), markerValue, "utf8");

    const instance = createFrozenWorker(name, homeDirectory, workspacePath);
    const host = new McpHost({
        instances: [
            {
                auth,
                name,
                policy: { capabilities: ["execute"], groups: ["bash"] },
                worker: instance
            }
        ],
        listenHost: "127.0.0.1",
        listenPort: 0
    });

    await instance.start();
    await host.start();

    return {
        host,
        instance,
        workspaceMarker: { name: markerName, value: markerValue },
        cleanupDirs: [homeDirectory, workspacePath]
    };
}

async function teardownFrozenWorker(
    host: McpHost,
    instance: { close(): Promise<void>; stop(): Promise<unknown> },
    cleanupDirs: readonly string[] = []
): Promise<void> {
    await host.stop().catch(() => undefined);
    await instance.stop().catch(() => undefined);
    await instance.close().catch(() => undefined);
    for (const dir of cleanupDirs) {
        await rm(dir, { force: true, recursive: true });
    }
}

async function reservePort(): Promise<number> {
    const { createServer } = await import("node:http");
    const server = createServer();
    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = requireTcpPort(server.address());
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
    return port;
}
