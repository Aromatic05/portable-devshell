import assert from "node:assert/strict";
import test from "node:test";
import { ControlHttpServer } from "../../../control/src/server/http/index.ts";
import { McpHost } from "../../src/server/Host.ts";
import { createTestMcpRuntimeState } from "../ContextRuntime.ts";

function port(address: { port: number } | string | null): number {
    assert.ok(address !== null && typeof address !== "string");
    return address.port;
}

test("enabling OAuth on a running MCP Host installs authorization routes and disables dynamic registration", async () => {
    const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const storage = await mkdtemp(join(tmpdir(), "mcp-dynamic-oauth-http-"));
    const clientId = "portable-devshell-dynamic-client";
    const adapterDir = join(storage, "adapter");
    await mkdir(adapterDir, { recursive: true });
    await writeFile(
        join(adapterDir, "Client.json"),
        JSON.stringify({
            [clientId]: {
                payload: {
                    client_id: clientId,
                    client_name: "Pre-registered MCP test",
                    grant_types: ["authorization_code", "refresh_token"],
                    redirect_uris: ["http://localhost/callback"],
                    response_types: ["code"],
                    token_endpoint_auth_method: "none",
                },
            },
        }),
        "utf8",
    );
    const http = new ControlHttpServer();
    const runtime = createTestMcpRuntimeState({ storageDir: storage });
    const host = new McpHost({
        instances: [{ name: "demo" }],
        listenHost: "127.0.0.1",
        listenPort: 0,
        publicBaseUrl: "http://127.0.0.1",
        storageDir: storage,
        toolSource: runtime.toolSource,
    }, runtime.state, http);
    try {
        await runtime.contexts.initialize();
        await host.start();
        const origin = `http://127.0.0.1:${port(host.server.address)}`;
        const authorize = () => fetch(`${origin}/authorize`, { signal: AbortSignal.timeout(5_000), redirect: "manual" });
        const metadata = () => fetch(`${origin}/.well-known/oauth-protected-resource/demo/mcp`, { signal: AbortSignal.timeout(5_000) });
        assert.equal((await authorize()).status, 404);
        assert.equal((await metadata()).status, 404);

        host.registerInstance({ name: "demo", auth: {
            enabled: true, provider: "oauth2", oauth2: { requiredScopes: ["mcp-dynamic"], resourceName: "demo" },
        } });
        assert.equal(host.status().authMode, "oauth2");
        assert.equal((await metadata()).status, 200);
        assert.notEqual((await authorize()).status, 404);

        // Dynamic client registration is retired: the endpoint must be gone.
        const registered = await fetch(`${origin}/register`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ redirect_uris: ["http://localhost/callback"] }),
        });
        assert.equal(registered.status, 404);

        // A pre-registered client without a declared scope must accept a scope
        // introduced after Provider warmup, without dynamic registration.
        const authorization = new URL(`${origin}/authorize`);
        for (const [name, value] of Object.entries({
            client_id: clientId, redirect_uri: "http://localhost/callback", response_type: "code",
            scope: "openid offline_access mcp-dynamic", state: "dynamic-scopes-123",
            code_challenge: "B".repeat(43), code_challenge_method: "S256",
            resource: "http://127.0.0.1/demo/mcp",
        })) authorization.searchParams.set(name, value);
        const authRequest = await fetch(authorization, { redirect: "manual" });
        assert.equal(authRequest.status, 303, "Scopes introduced after warmup must not be rejected by OIDC metadata validation");
        assert.match(authRequest.headers.get("location") ?? "", /^\/interaction\//u);

        host.registerInstance({ name: "demo", auth: { enabled: false, provider: "none" } });
        assert.equal(host.status().authMode, "none");
        assert.equal((await metadata()).status, 404);
        assert.equal((await authorize()).status, 404);

        host.registerInstance({ name: "demo", auth: {
            enabled: true, provider: "oauth2", oauth2: { requiredScopes: ["mcp-dynamic"], resourceName: "demo" },
        } });
        assert.notEqual((await authorize()).status, 404);
        host.unregisterInstance("demo");
        assert.equal((await authorize()).status, 404);
    } finally {
        await host.dispose();
        await runtime.state.close();
        await runtime.contexts.close();
        await http.close();
        await rm(storage, { recursive: true, force: true });
    }
});
