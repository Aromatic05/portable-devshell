import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { McpOAuthApprovalService } from "../../src/auth/oauth/McpOAuthApprovalService.ts";
import { McpOAuthInteraction } from "../../src/auth/oauth/McpOAuthInteraction.ts";
import { createMcpOAuthOidcFileAdapterFactory } from "../../src/auth/oauth/McpOAuthOidcFileAdapter.ts";
import { McpOAuthProviderRuntime } from "../../src/auth/oauth/McpOAuthProviderRuntime.ts";
import { McpOAuthRegistrationLimiter } from "../../src/auth/oauth/McpOAuthRegistrationLimiter.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const config = {
    documentationUrl: "https://docs.example.test/aromatic",
    requiredScopes: ["mcp"],
    resourceName: "aromatic"
};

test("McpOAuthProviderRuntime owns provider lifecycle, resources, metadata, and durable signing keys", async () => {
    const storageDir = await createTestTempDirectory("mcp-oauth-provider-runtime");
    const approvals = new McpOAuthApprovalService(storageDir);
    const runtime = new McpOAuthProviderRuntime({
        approvals,
        config,
        publicBaseUrl: "https://mcp.example.test/devshell/",
        storageDir,
        trustProxy: true
    });

    try {
        runtime.registerResource(new URL("https://mcp.example.test/devshell/demo/mcp"), config);
        await runtime.warmup();

        assert.equal(runtime.basePath, "/devshell");
        assert.equal(runtime.issuerUrl.href, "https://mcp.example.test/devshell/");
        assert.equal(runtime.provider.proxy, true);
        assert.equal(runtime.shouldHandleProviderPath("/.well-known/openid-configuration"), true);
        assert.equal(runtime.shouldHandleProviderPath("/devshell/authorize"), true);
        assert.equal(runtime.shouldHandleProviderPath("/unrelated"), false);
        assert.deepEqual(
            runtime.protectedResourceMetadata(
                new URL("https://mcp.example.test/devshell/demo/mcp")
            ),
            {
                authorization_servers: ["https://mcp.example.test/devshell"],
                resource: "https://mcp.example.test/devshell/demo/mcp",
                resource_documentation: "https://docs.example.test/aromatic",
                resource_name: "aromatic",
                scopes_supported: ["mcp"]
            }
        );

        const firstJwks = await readFile(join(storageDir, "jwks.json"), "utf8");
        if (process.platform !== "win32") {
            assert.equal((await stat(join(storageDir, "jwks.json"))).mode & 0o777, 0o600);
        }
        const reloaded = new McpOAuthProviderRuntime({
            approvals: new McpOAuthApprovalService(storageDir),
            config,
            publicBaseUrl: "https://mcp.example.test/devshell/",
            storageDir,
            trustProxy: false
        });
        reloaded.registerResource(new URL("https://mcp.example.test/devshell/demo/mcp"), config);
        await reloaded.warmup();
        const secondJwks = await readFile(join(storageDir, "jwks.json"), "utf8");
        assert.equal(secondJwks, firstJwks);
        assert.equal(reloaded.provider.proxy, false);
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("McpOAuthProviderRuntime upgrades persisted dynamic clients for OIDC refresh-token scopes", async () => {
    const storageDir = await createTestTempDirectory("mcp-oauth-client-scope-upgrade");
    const adapterDir = join(storageDir, "adapter");
    const clientFile = join(adapterDir, "Client.json");
    await mkdir(adapterDir, { recursive: true });
    await writeFile(clientFile, JSON.stringify({
        "claude-code": {
            payload: {
                application_type: "native",
                client_id: "claude-code",
                client_name: "Claude Code",
                grant_types: ["authorization_code", "refresh_token"],
                redirect_uris: ["http://localhost/callback"],
                response_types: ["code"],
                scope: "mcp",
                token_endpoint_auth_method: "none"
            }
        }
    }), "utf8");
    const runtime = new McpOAuthProviderRuntime({
        approvals: new McpOAuthApprovalService(storageDir),
        config,
        publicBaseUrl: "https://mcp.example.test/",
        storageDir
    });

    try {
        await runtime.warmup();
        const client = await runtime.provider.Client.find("claude-code");
        assert.notEqual(client, undefined);
        assert.deepEqual(
            new Set(client!.scope?.split(" ")),
            new Set(["mcp", "openid", "offline_access"])
        );
        const persisted = JSON.parse(await readFile(clientFile, "utf8")) as {
            "claude-code": { payload: { scope?: string } };
        };
        assert.deepEqual(
            new Set(persisted["claude-code"].payload.scope?.split(" ")),
            new Set(["mcp", "openid", "offline_access"])
        );
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});


test("OAuth resource verification rejects tokens with missing or malformed audience", async () => {
    const storageDir = await createTestTempDirectory("mcp-oauth-audience");
    const runtime = new McpOAuthProviderRuntime({
        approvals: new McpOAuthApprovalService(storageDir),
        config,
        publicBaseUrl: "https://mcp.example.test/",
        storageDir
    });
    const resource = new URL("https://mcp.example.test/demo/mcp");
    runtime.registerResource(resource, config);
    await runtime.warmup();

    try {
        const adapter = runtime.provider.AccessToken.adapter as {
            upsert(id: string, payload: Record<string, unknown>, expiresIn: number): Promise<void>;
        };
        const now = Math.floor(Date.now() / 1000);
        const base = {
            clientId: "client-audience-test",
            exp: now + 3600,
            iat: now,
            kind: "AccessToken",
            scope: "mcp"
        };
        await adapter.upsert("missing-audience", base, 3600);
        await adapter.upsert("malformed-audience", { ...base, aud: "not a URL" }, 3600);

        await assert.rejects(runtime.verifyAccessToken(resource, "missing-audience"), /resource|audience|invalid/iu);
        await assert.rejects(runtime.verifyAccessToken(resource, "malformed-audience"), /resource|audience|invalid/iu);
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("OAuth resource verification rejects tokens missing required resource scopes", async () => {
    const storageDir = await createTestTempDirectory("mcp-oauth-scope");
    const runtime = new McpOAuthProviderRuntime({
        approvals: new McpOAuthApprovalService(storageDir),
        config,
        publicBaseUrl: "https://mcp.example.test/",
        storageDir
    });
    const resource = new URL("https://mcp.example.test/demo/mcp");
    runtime.registerResource(resource, config);
    await runtime.warmup();

    try {
        const adapter = runtime.provider.AccessToken.adapter as {
            upsert(id: string, payload: Record<string, unknown>, expiresIn: number): Promise<void>;
        };
        const now = Math.floor(Date.now() / 1000);
        await adapter.upsert("insufficient-scope", {
            aud: resource.href,
            clientId: "client-scope-test",
            exp: now + 3600,
            iat: now,
            kind: "AccessToken",
            scope: "openid"
        }, 3600);

        await assert.rejects(
            runtime.verifyAccessToken(resource, "insufficient-scope"),
            /scope/iu
        );
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("OAuth provider reports destroyed access-token identity to long-lived resource listeners", async () => {
    const storageDir = await createTestTempDirectory("mcp-oauth-revocation-event");
    const runtime = new McpOAuthProviderRuntime({
        approvals: new McpOAuthApprovalService(storageDir),
        config,
        publicBaseUrl: "https://mcp.example.test/",
        storageDir
    });
    const resource = new URL("https://mcp.example.test/demo/mcp");
    runtime.registerResource(resource, config);
    await runtime.warmup();
    const revocations: Array<{ grantId: string }> = [];
    const unsubscribe = runtime.onAccessRevoked((revocation) => revocations.push(revocation));

    try {
        const adapter = runtime.provider.AccessToken.adapter as {
            upsert(id: string, payload: Record<string, unknown>, expiresIn: number): Promise<void>;
        };
        const now = Math.floor(Date.now() / 1000);
        await adapter.upsert("revocable-access", {
            aud: resource.href,
            clientId: "client-revocation-test",
            exp: now + 3600,
            grantId: "grant-revocation-test",
            iat: now,
            kind: "AccessToken",
            scope: "mcp"
        }, 3600);
        const token = await runtime.provider.AccessToken.find("revocable-access");
        assert.notEqual(token, undefined);

        await token!.destroy();

        assert.deepEqual(revocations, [{ grantId: "grant-revocation-test" }]);
    } finally {
        unsubscribe();
        await rm(storageDir, { force: true, recursive: true });
    }
});


test("McpOAuthInteraction renders escaped approval state with the configured base path", async () => {
    const storageDir = await createTestTempDirectory("mcp-oauth-interaction");
    const approvals = new McpOAuthApprovalService(storageDir);
    await approvals.warmup();
    const interaction = new McpOAuthInteraction({
        accountId: "aromatic<admin>",
        approvals,
        basePath: "/devshell",
        provider: () => {
            throw new Error("provider is not needed for rendering");
        }
    });

    try {
        const html = interaction.renderPage({
            accountId: "aromatic<admin>",
            approvalId: "approval-1",
            approvalKind: "authorization",
            approvalStatus: "pending",
            clientName: "Client <script>",
            promptName: "consent",
            requestedResources: [{
                indicator: "https://mcp.example.test/demo/mcp?a=<b>",
                scopes: ["mcp", "write<all>"]
            }],
            requiredScopes: ["openid", "mcp"]
        });

        assert.match(html, /Client &lt;script&gt;/u);
        assert.match(html, /aromatic&lt;admin&gt;/u);
        assert.match(html, /write&lt;all&gt;/u);
        assert.match(html, /\/devshell\/oauth\/approvals\/approval-1/u);
        assert.doesNotMatch(html, /Client <script>/u);
        assert.match(html, /Waiting for administrator approval/u);
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("McpOAuthInteraction renders approved registration as a reload flow", async () => {
    const storageDir = await createTestTempDirectory("mcp-oauth-registration-page");
    const interaction = new McpOAuthInteraction({
        accountId: "aromatic",
        approvals: new McpOAuthApprovalService(storageDir),
        basePath: "",
        provider: () => {
            throw new Error("provider is not needed for rendering");
        }
    });

    try {
        const html = interaction.renderPage({
            accountId: "aromatic",
            approvalId: "approval-registration",
            approvalKind: "registration",
            approvalStatus: "approved",
            clientName: "ChatGPT",
            promptName: "login",
            requestedResources: [],
            requiredScopes: []
        });

        assert.match(html, /Administrator approved this request/u);
        assert.match(html, /window\.location\.reload\(\)/u);
        assert.match(html, /fetch\("\/oauth\/approvals\/approval-registration"/u);
        assert.doesNotMatch(html, /disabled/u);
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("OIDC file adapter serializes concurrent updates without losing records", async () => {
    const storageDir = await createTestTempDirectory("mcp-oauth-adapter");
    const adapter = createMcpOAuthOidcFileAdapterFactory(storageDir)("Client");

    try {
        await Promise.all(
            Array.from({ length: 64 }, async (_, index) => {
                await adapter.upsert(`client-${index}`, { clientId: `client-${index}` } as never, 3600);
            })
        );
        for (let index = 0; index < 64; index += 1) {
            assert.equal((await adapter.find(`client-${index}`))?.clientId, `client-${index}`);
        }
        if (process.platform !== "win32") {
            assert.equal((await stat(join(storageDir, "Client.json"))).mode & 0o777, 0o600);
        }
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("OAuth registration limiter rejects bursts above its configured quota", () => {
    let now = 0;
    const limiter = new McpOAuthRegistrationLimiter({ maxRequests: 2, now: () => now, windowMs: 1000 });
    assert.equal(limiter.accept("client-a"), true);
    assert.equal(limiter.accept("client-a"), true);
    assert.equal(limiter.accept("client-a"), false);
    now = 1001;
    assert.equal(limiter.accept("client-a"), true);
});
