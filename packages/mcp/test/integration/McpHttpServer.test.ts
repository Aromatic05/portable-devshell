import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { requireTcpPort, startLoopbackHttpProxy } from "../../../../test/TestHttpSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { parseMcpHttpResponse } from "../TestMcpHttpResponse.ts";

import { McpHost } from "@portable-devshell/mcp/testing";
import type { McpAuthConfig, McpHostInstanceConfig } from "@portable-devshell/mcp";

const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

test("missing instance returns 404", async () => {
    const host = createHost();
    await host.start();

    try {
        const port = requireTcpPort(host.server.address);

        const response = await fetch(`http://127.0.0.1:${port}/missing/mcp`, {
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
        const port = requireTcpPort(host.server.address);

        const response = await fetch(`http://127.0.0.1:${port}/demo/mcp`, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json"
            },
            body: JSON.stringify(await readFixture("mcp-initialize.json"))
        });
        const payload = parseMcpHttpResponse<{ result?: { protocolVersion?: string } }>(await response.text());

        assert.equal(response.status, 200);
        assert.equal(typeof payload.result?.protocolVersion, "string");
        assert.equal(response.headers.get("mcp-session-id"), null);
    } finally {
        await host.stop();
    }
});

test("a namespace with no auth remains runnable behind a public MCP URL", async () => {
    const host = createHost({ publicBaseUrl: "https://dev.aromatic05.top" });
    await host.start();

    try {
        const port = requireTcpPort(host.server.address);
        const response = await fetch(`http://127.0.0.1:${port}/demo/mcp`, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json"
            },
            body: JSON.stringify(await readFixture("mcp-initialize.json"))
        });

        assert.equal(response.status, 200);
    } finally {
        await host.stop();
    }
});

test("a running host can add an OAuth namespace without exposing it as local auth", async () => {
    const storageDir = await createTestTempDirectory("mcp-dynamic-oauth");
    const host = createHost({
        publicBaseUrl: "http://127.0.0.1",
        storageDir
    });
    await host.start();

    try {
        host.registerInstance(createInstance("dynamic", {
            enabled: true,
            oauth2: {
                requiredScopes: ["mcp-dynamic"],
                resourceName: "dynamic"
            },
            provider: "oauth2"
        }));
        const port = requireTcpPort(host.server.address);
        const endpoint = `http://127.0.0.1:${port}/dynamic/mcp`;
        const unauthorized = await fetch(endpoint, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json"
            },
            body: JSON.stringify(await readFixture("mcp-initialize.json"))
        });
        assert.equal(unauthorized.status, 401);

        const metadata = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/dynamic/mcp`);
        assert.equal(metadata.status, 200);
        assert.deepEqual(await metadata.json(), {
            authorization_servers: ["http://127.0.0.1"],
            resource: "http://127.0.0.1/dynamic/mcp",
            resource_name: "dynamic",
            scopes_supported: ["mcp-dynamic"]
        });
        assert.equal(host.status().authMode, "oauth2");
        assert.equal(host.status().oauthReady, true);
    } finally {
        await host.stop();
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("MCP status reports observable listener state without claiming unimplemented protocol or public reachability probes", async () => {
    const host = createHost({ publicBaseUrl: "https://mcp.example.test" });
    const stopped = host.status();
    assert.equal(stopped.running, false);
    assert.equal(stopped.reason, "MCP host is not listening.");
    assert.equal("protocolReadiness" in stopped, false);
    assert.equal("publicReachability" in stopped, false);

    await host.start();
    try {
        const running = host.status();
        assert.equal(running.running, true);
        assert.equal(typeof running.listenAddress, "string");
        assert.equal("reason" in running, false);
        assert.equal("protocolReadiness" in running, false);
        assert.equal("publicReachability" in running, false);
    } finally {
        await host.stop();
    }
});

test("oauth2 emits HTTPS endpoints behind a loopback reverse proxy", async () => {
    const storageDir = await createTestTempDirectory("mcp-proxy");
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
        const port = requireTcpPort(host.server.address);

        const response = await fetch(`http://127.0.0.1:${port}/.well-known/openid-configuration`, {
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

test("oauth2 keeps a public path prefix on resources while using the origin as issuer", async () => {
    const proxy = await startLoopbackHttpProxy();
    const origin = proxy.origin;
    const storageDir = await createTestTempDirectory("mcp-prefix");
    const host = createHost({
        auth: {
            enabled: true,
            oauth2: {
                requiredScopes: ["mcp"],
                resourceName: "aromatic"
            },
            provider: "oauth2"
        },
        listenPort: 0,
        publicBaseUrl: `${origin}/devshell`,
        storageDir
    });
    await host.start();
    proxy.setTarget(`http://127.0.0.1:${requireTcpPort(host.server.address)}`);

    try {
        const protectedMetadata = await fetch(
            `${origin}/.well-known/oauth-protected-resource/devshell/demo/mcp`
        );
        assert.equal(protectedMetadata.status, 200);
        const resource = await protectedMetadata.json() as {
            authorization_servers: string[];
            resource: string;
        };
        assert.deepEqual(resource.authorization_servers, [origin]);
        assert.equal(resource.resource, `${origin}/devshell/demo/mcp`);

        const authorizationMetadata = await fetch(`${origin}/.well-known/openid-configuration`);
        assert.equal(authorizationMetadata.status, 200);
        const issuer = await authorizationMetadata.json() as {
            authorization_endpoint: string;
            issuer: string;
        };
        assert.equal(issuer.issuer, origin);
        assert.equal(issuer.authorization_endpoint, `${origin}/authorize`);
    } finally {
        try {
            await host.stop();
            await rm(storageDir, { force: true, recursive: true });
        } finally {
            await proxy.close();
        }
    }
});

async function readFixture(name: string): Promise<JsonValue> {
    return JSON.parse(await readFile(resolve(fixturesDirectory, name), "utf8")) as JsonValue;
}

function createHost(overrides?: {
    auth?: McpAuthConfig;
    listenPort?: number;
    publicBaseUrl?: string;
    storageDir?: string;
}): McpHost {
    return new McpHost({
        listenHost: "127.0.0.1",
        listenPort: overrides?.listenPort ?? 0,
        publicBaseUrl: overrides?.publicBaseUrl,
        storageDir: overrides?.storageDir,
        instances: [
            createInstance("demo", overrides?.auth ?? { enabled: false, provider: "none" })
        ]
    });
}

function createInstance(name: string, auth: McpAuthConfig): McpHostInstanceConfig {
    return {
                auth,
                name,
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
            };
}

test("running host replaces and unregisters instance bindings without restart", async () => {
    const host = createHost();
    await host.start();

    try {
        const port = requireTcpPort(host.server.address);
        const endpoint = `http://127.0.0.1:${port}/demo/mcp`;

        assert.deepEqual(await initializeAndListTools(endpoint), ["context_acquire", "context_renew", "environ_info", "bash_run"]);

        host.registerInstance({
            name: "demo",
            policy: { capabilities: ["read"], groups: ["file"] },
            worker: createToolWorker({ requiredCapabilities: ["read"], group: "file", name: "file_read" })
        });
        assert.deepEqual(await initializeAndListTools(endpoint), ["context_acquire", "context_renew", "environ_info", "file_read"]);

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
    const initializeBody = parseMcpHttpResponse<{ result?: { protocolVersion?: string } }>(await initialize.text());
    assert.equal(initialize.headers.get("mcp-session-id"), null);
    const headers = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": String(initializeBody.result?.protocolVersion ?? "")
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
