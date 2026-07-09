import assert from "node:assert/strict";
import { createServer as createNodeServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { McpHost } from "@portable-devshell/mcp";

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
    const provider = await createOidcProvider();
    const port = await reservePort();
    const host = createHost({
        auth: {
            enabled: true,
            oauth2: {
                audience: "aromatic-mcp",
                documentationUrl: "https://docs.example.com/aromatic",
                issuer: provider.issuer,
                requiredScopes: ["mcp"],
                resourceName: "aromatic"
            },
            provider: "oauth2"
        },
        listenPort: port,
        publicBaseUrl: `http://127.0.0.1:${port}`
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
            authorization_servers: [provider.issuer],
            jwks_uri: provider.jwksUri,
            resource: endpoint,
            resource_documentation: "https://docs.example.com/aromatic",
            resource_name: "aromatic",
            scopes_supported: ["mcp"]
        });

        const authorizationServerMetadata = await fetch(`http://127.0.0.1:${address.port}/.well-known/oauth-authorization-server`);
        assert.equal(authorizationServerMetadata.status, 200);
        assert.equal((await authorizationServerMetadata.json()).issuer, provider.issuer);

        const token = await provider.issueToken({
            audience: "aromatic-mcp",
            scope: "mcp"
        });
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                authorization: `Bearer ${token}`,
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
        await provider.close();
    }
});

async function readFixture(name: string): Promise<JsonValue> {
    return JSON.parse(await readFile(resolve(fixturesDirectory, name), "utf8")) as JsonValue;
}

function createHost(overrides?: {
    auth?: ConstructorParameters<typeof McpHost>[0]["auth"];
    listenPort?: number;
    publicBaseUrl?: string;
}): McpHost {
    return new McpHost({
        listenHost: "127.0.0.1",
        listenPort: overrides?.listenPort ?? 0,
        publicBaseUrl: overrides?.publicBaseUrl,
        auth: overrides?.auth ?? { enabled: false, provider: "none" },
        instances: [
            {
                name: "demo",
                allowlist: ["bash_run"],
                worker: {
                    snapshot() {
                        return { ready: true };
                    },
                    listTools() {
                        return [{ name: "bash_run", description: "Run shell", inputSchema: { type: "object" } }];
                    },
                    async callTool(_toolName: string, _input: unknown, _context: { source: "mcp" }) {
                        return { exitCode: 0, stderr: "", stdout: "ok\n" };
                    }
                } as never
            }
        ]
    });
}

async function createOidcProvider() {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.alg = "RS256";
    jwk.kid = "aromatic-kid";
    jwk.use = "sig";

    const server = createNodeServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");

        if (url.pathname === "/.well-known/openid-configuration") {
            const issuer = `http://127.0.0.1:${address.port}`;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    authorization_endpoint: `${issuer}/authorize`,
                    grant_types_supported: ["authorization_code", "refresh_token"],
                    issuer,
                    jwks_uri: `${issuer}/jwks`,
                    response_types_supported: ["code"],
                    subject_types_supported: ["public"],
                    token_endpoint: `${issuer}/token`,
                    id_token_signing_alg_values_supported: ["RS256"]
                })
            );
            return;
        }

        if (url.pathname === "/jwks") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ keys: [jwk] }));
            return;
        }

        response.writeHead(404);
        response.end();
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");

    const issuer = `http://127.0.0.1:${address.port}`;

    return {
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve();
                });
            });
        },
        issueToken: async (options: { audience: string; scope: string }) => {
            return await new SignJWT({
                client_id: "chatgpt-connector",
                scope: options.scope
            })
                .setProtectedHeader({ alg: "RS256", kid: "aromatic-kid" })
                .setAudience(options.audience)
                .setExpirationTime("5m")
                .setIssuedAt()
                .setIssuer(issuer)
                .setSubject("chatgpt-connector")
                .sign(privateKey);
        },
        issuer,
        jwksUri: `${issuer}/jwks`
    };
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
