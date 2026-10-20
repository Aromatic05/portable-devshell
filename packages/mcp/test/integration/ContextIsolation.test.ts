import assert from "node:assert/strict";
import type { JsonValue } from "@portable-devshell/shared";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { McpOAuthApprovalService } from "../../src/oauth/interaction/Approval.ts";
import { McpOAuthProviderRuntime } from "../../src/oauth/provider/Provider.ts";
import { McpNativeToolResult } from "../../src/protocol/Endpoint.ts";
import { createTestMcpEndpoint, createTestMcpRuntimeState } from "../ContextRuntime.ts";

test("authorized OAuth clients with distinct principals cannot read or mutate each other's Context", async () => {
    const storageDir = await createTestTempDirectory("mcp-context-isolation");
    const config = { requiredScopes: ["mcp"], resourceName: "isolation-fixture" };
    const resource = new URL("https://mcp.example.test/demo/mcp");
    const oauth = new McpOAuthProviderRuntime({
        accountId: "isolated-test-account",
        approvals: new McpOAuthApprovalService(storageDir),
        config,
        publicBaseUrl: "https://mcp.example.test/",
        storageDir,
    });
    const release = oauth.registerResource(resource, config);
    const runtime = createTestMcpRuntimeState({
        contextFile: join(storageDir, "contexts.jsonl"),
        storageDir,
        resolveTarget: () => ({
            async dispatch(request) {
                assert.ok(request.execute);
                return await request.execute(
                    request.callId, request.value.payload, request.value, request.signal,
                ) as JsonValue;
            },
        }),
    });
    const endpoint = createTestMcpEndpoint({
        instanceName: "demo",
        context: runtime.contextTransport,
        tools: runtime.toolCallRuntime.api,
        toolSource: runtime.toolSource,
    });
    const call = async (principal: string, input: Record<string, string>) => {
        const result = await endpoint.callTool("environ_info", input, { principal });
        return (result instanceof McpNativeToolResult ? result.structuredContent : result) as {
            ctxId: string;
        };
    };

    try {
        await runtime.contexts.initialize();
        await oauth.warmup();
        const adapter = oauth.provider.AccessToken.adapter;
        const now = Math.floor(Date.now() / 1000);
        for (const clientId of ["client-alpha", "client-beta"]) {
            // Without an account subject, the current verifier uses clientId as principal.
            await adapter.upsert(`${clientId}-token`, {
                aud: resource.href,
                clientId,
                exp: now + 3600,
                grantId: `${clientId}-grant`,
                iat: now,
                kind: "AccessToken",
                scope: "mcp",
            }, 3600);
        }
        const alphaAuth = await oauth.verifyAccessToken(resource, "client-alpha-token");
        const betaAuth = await oauth.verifyAccessToken(resource, "client-beta-token");
        assert.equal(alphaAuth.clientId, "client-alpha");
        assert.equal(betaAuth.clientId, "client-beta");
        assert.deepEqual(alphaAuth.scopes, ["mcp"]);
        assert.deepEqual(betaAuth.scopes, ["mcp"]);
        const alpha = await call(alphaAuth.clientId, { workspace: join(storageDir, "alpha") });
        const beta = await call(betaAuth.clientId, { workspace: join(storageDir, "beta") });
        assert.ok(typeof alpha.ctxId === "string");
        assert.ok(typeof beta.ctxId === "string");
        assert.notEqual(alpha.ctxId, beta.ctxId);
        const before = await runtime.contexts.registry.list();
        assert.equal(before.length, 2);
        assert.equal(before.find(({ ctxId }) => ctxId === alpha.ctxId)?.principal, alphaAuth.clientId);
        assert.equal(before.find(({ ctxId }) => ctxId === beta.ctxId)?.principal, betaAuth.clientId);

        await assert.rejects(
            call(betaAuth.clientId, { ctxId: alpha.ctxId }),
            { code: "mcp.contextInvalid" },
        );
        await assert.rejects(
            call(alphaAuth.clientId, {
                ctxId: beta.ctxId,
                workspace: join(storageDir, "cross-client-write"),
            }),
            { code: "mcp.contextInvalid" },
        );
        assert.deepEqual(await runtime.contexts.registry.list(), before);

        const ownRead = await call(alphaAuth.clientId, { ctxId: alpha.ctxId });
        const ownWrite = await call(betaAuth.clientId, {
            ctxId: beta.ctxId,
            workspace: join(storageDir, "beta-updated"),
        });
        assert.equal(ownRead.ctxId, alpha.ctxId);
        assert.equal(ownWrite.ctxId, beta.ctxId);
        const after = await runtime.contexts.registry.list();
        assert.deepEqual(
            after.find(({ ctxId }) => ctxId === alpha.ctxId)?.environments,
            before.find(({ ctxId }) => ctxId === alpha.ctxId)?.environments,
        );
        assert.equal(
            after.find(({ ctxId }) => ctxId === beta.ctxId)?.environments[0]?.workspace,
            join(storageDir, "beta-updated"),
        );
    } finally {
        release();
        runtime.closeContextTools();
        runtime.toolCallRuntime.close();
        await runtime.state.close();
        await runtime.contexts.close();
        await rm(storageDir, { recursive: true, force: true });
    }
});
