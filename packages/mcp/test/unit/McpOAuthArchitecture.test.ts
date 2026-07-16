import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { McpOAuthApprovalService } from "../../dist/auth/oauth/McpOAuthApprovalService.js";
import { McpOAuthInteraction } from "../../dist/auth/oauth/McpOAuthInteraction.js";
import { McpOAuthProviderRuntime } from "../../dist/auth/oauth/McpOAuthProviderRuntime.js";

const config = {
    documentationUrl: "https://docs.example.test/aromatic",
    requiredScopes: ["mcp"],
    resourceName: "aromatic"
};

test("McpOAuthProviderRuntime owns provider lifecycle, resources, metadata, and durable signing keys", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "mcp-oauth-provider-runtime-"));
    const approvals = new McpOAuthApprovalService(storageDir);
    const runtime = new McpOAuthProviderRuntime({
        approvals,
        config,
        publicBaseUrl: "https://mcp.example.test/devshell/",
        storageDir,
        trustProxy: true
    });

    try {
        runtime.registerResource(new URL("https://mcp.example.test/devshell/demo/mcp"));
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
        const reloaded = new McpOAuthProviderRuntime({
            approvals: new McpOAuthApprovalService(storageDir),
            config,
            publicBaseUrl: "https://mcp.example.test/devshell/",
            storageDir,
            trustProxy: false
        });
        reloaded.registerResource(new URL("https://mcp.example.test/devshell/demo/mcp"));
        await reloaded.warmup();
        const secondJwks = await readFile(join(storageDir, "jwks.json"), "utf8");
        assert.equal(secondJwks, firstJwks);
        assert.equal(reloaded.provider.proxy, false);
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});


test("McpOAuthInteraction renders escaped approval state with the configured base path", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "mcp-oauth-interaction-"));
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
    const storageDir = await mkdtemp(join(tmpdir(), "mcp-oauth-registration-page-"));
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
