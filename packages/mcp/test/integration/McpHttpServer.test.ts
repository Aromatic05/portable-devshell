import assert from "node:assert/strict";
import { createServer as createNodeServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { McpHost } from "@portable-devshell/mcp/testing";

const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

test("missing instance returns 404", async () => {
    const host = createHost();
    await host.start();

    try {
        const address = host.server.address;
        assert.notEqual(address, null);
        assert.equal(typeof address, "object");

        const response = await fetch(`http://127.0.0.1:${address.port}/missing/mcp`, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json"
            },
            body: JSON.stringify(await readFixture("mcp-initialize.json"))
        });

        assert.equal(response.status, 404);
    } finally {
        await host.stop();
    }
});

test("initialize succeeds over HTTP", async () => {
    const host = createHost();
    await host.start();

    try {
        const address = host.server.address;
        assert.notEqual(address, null);
        assert.equal(typeof address, "object");

        const response = await fetch(`http://127.0.0.1:${address.port}/demo/mcp`, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json"
            },
            body: JSON.stringify(await readFixture("mcp-initialize.json"))
        });
        const payload = await response.json() as { result?: { protocolVersion?: string } };

        assert.equal(response.status, 200);
        assert.equal(typeof payload.result?.protocolVersion, "string");
        assert.equal(typeof response.headers.get("mcp-session-id"), "string");
    } finally {
        await host.stop();
    }
});

test("oauth2 exposes protected resource metadata and accepts a valid bearer token", async () => {
    const port = await reservePort();
    const storageDir = await mkdtemp(join(tmpdir(), "portable-devshell-mcp-oidc-"));
    const host = createHost({
        auth: {
            enabled: true,
            oauth2: {
                documentationUrl: "https://docs.example.com/aromatic",
                requiredScopes: ["mcp"],
                resourceName: "aromatic"
            },
            provider: "oauth2"
        },
        listenPort: port,
        publicBaseUrl: `http://127.0.0.1:${port}`,
        storageDir
    });

    await host.start();

    try {
        const address = host.server.address;
        assert.notEqual(address, null);
        assert.equal(typeof address, "object");

        const endpoint = `http://127.0.0.1:${address.port}/demo/mcp`;
        const unauthorized = await fetch(endpoint, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json"
            },
            body: JSON.stringify(await readFixture("mcp-initialize.json"))
        });

        assert.equal(unauthorized.status, 401);
        assert.match(String(unauthorized.headers.get("www-authenticate")), /resource_metadata=/u);

        const protectedMetadata = await fetch(`http://127.0.0.1:${address.port}/.well-known/oauth-protected-resource/demo/mcp`);
        assert.equal(protectedMetadata.status, 200);
        assert.deepEqual(await protectedMetadata.json(), {
            authorization_servers: [`http://127.0.0.1:${address.port}`],
            resource: endpoint,
            resource_documentation: "https://docs.example.com/aromatic",
            resource_name: "aromatic",
            scopes_supported: ["mcp"]
        });

        const authorizationServerMetadata = await fetch(`http://127.0.0.1:${address.port}/.well-known/openid-configuration`);
        assert.equal(authorizationServerMetadata.status, 200);
        const metadata = await authorizationServerMetadata.json() as {
            authorization_endpoint: string;
            issuer: string;
            registration_endpoint: string;
            token_endpoint: string;
        };
        assert.equal(metadata.issuer, `http://127.0.0.1:${address.port}`);

        const clientRegistration = await fetch(metadata.registration_endpoint, {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: JSON.stringify({
                application_type: "native",
                client_name: "codex-aromatic",
                grant_types: ["authorization_code", "refresh_token"],
                redirect_uris: ["http://127.0.0.1:45678/callback"],
                response_types: ["code"],
                token_endpoint_auth_method: "none"
            })
        });
        assert.equal(clientRegistration.status, 201);
        const client = await clientRegistration.json() as { client_id: string; redirect_uris: string[] };
        assert.equal(typeof client.client_id, "string");

        const verifier = base64Url(randomBytes(32));
        const challenge = base64Url(createHash("sha256").update(verifier).digest());
        const redirectUri = client.redirect_uris[0]!;
        const authorizationUrl = new URL(metadata.authorization_endpoint);
        authorizationUrl.searchParams.set("client_id", client.client_id);
        authorizationUrl.searchParams.set("redirect_uri", redirectUri);
        authorizationUrl.searchParams.set("response_type", "code");
        authorizationUrl.searchParams.set("scope", "openid offline_access mcp");
        authorizationUrl.searchParams.set("code_challenge", challenge);
        authorizationUrl.searchParams.set("code_challenge_method", "S256");
        authorizationUrl.searchParams.set("resource", endpoint);

        let approvalKind: "authorization" | "registration" = "registration";
        const code = await authorizeViaInteractions(authorizationUrl, redirectUri, async () => {
            const approval = await waitForPendingApproval(host, approvalKind);
            await host.oauthApprovals?.decide(approval.approvalId, "approve", "tui");

            if (approvalKind === "registration") {
                approvalKind = "authorization";
                return "reload";
            }

            return "submit";
        });

        const tokenResponse = await fetch(metadata.token_endpoint, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
                client_id: client.client_id,
                code,
                code_verifier: verifier,
                grant_type: "authorization_code",
                redirect_uri: redirectUri
            })
        });
        assert.equal(tokenResponse.status, 200);
        const tokens = await tokenResponse.json() as { access_token: string; expires_in: number };
        assert.equal(typeof tokens.access_token, "string");
        assert.equal(tokens.expires_in, 24 * 60 * 60);

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                authorization: `Bearer ${tokens.access_token}`,
                "content-type": "application/json"
            },
            body: JSON.stringify(await readFixture("mcp-initialize.json"))
        });
        const payload = await response.json() as { result?: { protocolVersion?: string } };

        assert.equal(response.status, 200);
        assert.equal(typeof payload.result?.protocolVersion, "string");
        assert.equal(typeof response.headers.get("mcp-session-id"), "string");
    } finally {
        await host.stop();
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("oauth2 emits HTTPS endpoints behind a loopback reverse proxy", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "portable-devshell-mcp-proxy-"));
    const host = createHost({
        auth: {
            enabled: true,
            oauth2: {
                documentationUrl: "https://docs.example.com/aromatic",
                requiredScopes: ["mcp"],
                resourceName: "aromatic"
            },
            provider: "oauth2"
        },
        publicBaseUrl: "https://mcp.example.com",
        storageDir
    });

    await host.start();

    try {
        const address = host.server.address;
        assert.notEqual(address, null);
        assert.equal(typeof address, "object");

        const response = await fetch(`http://127.0.0.1:${address.port}/.well-known/openid-configuration`, {
            headers: {
                host: "mcp.example.com",
                "x-forwarded-host": "mcp.example.com",
                "x-forwarded-proto": "https"
            }
        });
        assert.equal(response.status, 200);
        const metadata = await response.json() as { authorization_endpoint: string; issuer: string; token_endpoint: string };

        assert.equal(metadata.issuer, "https://mcp.example.com");
        assert.equal(metadata.authorization_endpoint, "https://mcp.example.com/authorize");
        assert.equal(metadata.token_endpoint, "https://mcp.example.com/token");
    } finally {
        await host.stop();
        await rm(storageDir, { force: true, recursive: true });
    }
});

async function readFixture(name: string): Promise<JsonValue> {
    return JSON.parse(await readFile(resolve(fixturesDirectory, name), "utf8")) as JsonValue;
}

function createHost(overrides?: {
    auth?: ConstructorParameters<typeof McpHost>[0]["auth"];
    listenPort?: number;
    publicBaseUrl?: string;
    storageDir?: string;
}): McpHost {
    return new McpHost({
        listenHost: "127.0.0.1",
        listenPort: overrides?.listenPort ?? 0,
        publicBaseUrl: overrides?.publicBaseUrl,
        storageDir: overrides?.storageDir,
        auth: overrides?.auth ?? { enabled: false, provider: "none" },
        instances: [
            {
                name: "demo",
                policy: { capabilities: ["execute"], groups: ["bash"] },
                worker: {
                    async appendMcpSessionClosed(_sessionId: string) {},
                    async appendMcpSessionOpened(_sessionId: string) {},
                    async appendMcpToolCalled(_toolName: string, _context: { ctxId?: string; requestId?: string }) {},
                    snapshot() {
                        return { ready: true };
                    },
                    listTools() {
                        return [{ requiredCapabilities: ["execute"], group: "bash", name: "bash_run", description: "Run shell", inputSchema: { type: "object" }, outputSchema: { type: "object" } }];
                    },
                    async callTool(_toolName: string, _input: unknown, _context: { source: "mcp" }) {
                        return { exitCode: 0, stderr: "", stdout: "ok\n" };
                    }
                } as never
            }
        ]
    });
}

async function reservePort(): Promise<number> {
    const server = createNodeServer();

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const { port } = address;

    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    });

    return port;
}

async function authorizeViaInteractions(
    authorizationUrl: URL,
    redirectUri: string,
    approve: () => Promise<"reload" | "submit">
): Promise<string> {
    let currentUrl = authorizationUrl.href;
    let method: "GET" | "POST" = "GET";
    let cookieHeader = "";

    for (let step = 0; step < 10; step += 1) {
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

        if (response.status === 200) {
            const html = await response.text();

            if (html.includes("window.location.reload()")) {
                assert.equal(await approve(), "reload");
                assert.match(html, /window\.location\.reload\(\)/u);
                method = "GET";
                continue;
            }

            const blocked = await fetch(currentUrl, {
                method: "POST",
                headers: {
                    cookie: cookieHeader,
                    "content-type": "application/x-www-form-urlencoded"
                },
                body: new URLSearchParams({ submit: "1" }).toString(),
                redirect: "manual"
            });
            assert.equal(blocked.status, 409);
            assert.equal(await approve(), "submit");
            assert.match(html, /form\.submit\(\)/u);
            method = "POST";
            continue;
        }

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
    }

    throw new Error("authorization flow did not complete");
}

async function waitForPendingApproval(host: McpHost, kind: "authorization" | "registration") {
    const approval = (await host.oauthApprovals?.list())?.find((candidate) => candidate.kind === kind && candidate.status === "pending");
    assert.notEqual(approval, undefined, `pending ${kind} approval was not created`);
    return approval!;
}

function base64Url(value: Buffer): string {
    return value.toString("base64url");
}

function mergeCookieHeader(existing: string, response: Response): string {
    const nextEntries = readSetCookieEntries(response);
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

function readSetCookieEntries(response: Response): string[] {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    if (typeof headers.getSetCookie === "function") {
        return headers.getSetCookie();
    }

    const header = response.headers.get("set-cookie");
    return header === null ? [] : [header];
}

test("running host replaces and unregisters instance bindings without restart", async () => {
    const host = createHost();
    await host.start();

    try {
        const address = host.server.address;
        assert.notEqual(address, null);
        assert.equal(typeof address, "object");
        const endpoint = `http://127.0.0.1:${address.port}/demo/mcp`;

        assert.deepEqual(await initializeAndListTools(endpoint), ["environ_info", "bash_run"]);

        host.registerInstance({
            name: "demo",
            policy: { capabilities: ["read"], groups: ["file"] },
            worker: createToolWorker({ requiredCapabilities: ["read"], group: "file", name: "file_read" })
        });
        assert.deepEqual(await initializeAndListTools(endpoint), ["environ_info", "file_read"]);

        host.unregisterInstance("demo");
        const missing = await fetch(endpoint, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json"
            },
            body: JSON.stringify(await readFixture("mcp-initialize.json"))
        });
        assert.equal(missing.status, 404);
    } finally {
        await host.stop();
    }
});

async function initializeAndListTools(endpoint: string): Promise<string[]> {
    const initialize = await fetch(endpoint, {
        method: "POST",
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json"
        },
        body: JSON.stringify(await readFixture("mcp-initialize.json"))
    });
    assert.equal(initialize.status, 200);
    const initializeBody = await initialize.json() as { result?: { protocolVersion?: string } };
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.equal(typeof sessionId, "string");
    const headers = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": String(initializeBody.result?.protocolVersion ?? ""),
        "mcp-session-id": String(sessionId)
    };

    const initialized = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized"
        })
    });
    assert.equal(initialized.status, 202);

    const listed = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
            id: "list-tools",
            jsonrpc: "2.0",
            method: "tools/list"
        })
    });
    assert.equal(listed.status, 200);
    const payload = await listed.json() as { result?: { tools?: Array<{ name: string }> } };
    return payload.result?.tools?.map((tool) => tool.name) ?? [];
}

function createToolWorker(tool: { requiredCapabilities: readonly ("execute" | "read" | "write")[]; group: string; name: string }) {
    return {
        async appendMcpSessionClosed(_sessionId: string) {},
        async appendMcpSessionOpened(_sessionId: string) {},
        async appendMcpToolCalled(_toolName: string, _context: { ctxId?: string; requestId?: string }) {},
        snapshot() {
            return { ready: true };
        },
        listTools() {
            return [{
                ...tool,
                description: tool.name,
                inputSchema: { type: "object" },
                outputSchema: { type: "object" }
            }];
        },
        async callTool(_toolName: string, _input: unknown, _context: { source: "mcp" }) {
            return { ok: true };
        }
    } as never;
}
