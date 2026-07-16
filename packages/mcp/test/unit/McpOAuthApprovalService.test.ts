import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { McpOAuthApprovalService } from "../../dist/auth/oauth/McpOAuthApprovalService.js";

test("OAuth approvals persist registration and authorization decisions", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "portable-devshell-oauth-approvals-"));
    const service = new McpOAuthApprovalService(storageDir);

    try {
        await service.warmup();
        const registration = await service.registerClient({
            clientId: "chatgpt",
            clientName: "ChatGPT",
            redirectUris: ["https://chatgpt.com/callback"]
        });
        assert.equal(registration.kind, "registration");
        assert.equal(registration.status, "pending");

        await service.decide(registration.approvalId, "approve", "tui");
        const authorization = await service.requestAuthorization("interaction-1", {
            clientId: "chatgpt",
            clientName: "ChatGPT",
            redirectUris: ["https://chatgpt.com/callback"],
            requestedResources: ["https://example.test/demo/mcp"],
            requestedScopes: ["openid", "mcp"]
        });
        assert.equal(authorization.kind, "authorization");
        assert.equal(authorization.status, "pending");

        await service.decide(authorization.approvalId, "deny", "tui");

        const reloaded = new McpOAuthApprovalService(storageDir);
        await reloaded.warmup();
        assert.deepEqual(
            (await reloaded.list()).map((request) => [request.kind, request.status]),
            [["authorization", "denied"], ["registration", "approved"]]
        );
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("OAuth approvals expire after five-minute policy is exceeded", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "portable-devshell-oauth-approval-expiry-"));
    let now = 0;
    const service = new McpOAuthApprovalService(storageDir, { now: () => now, timeoutMs: 300_000 });

    try {
        await service.warmup();
        const request = await service.registerClient({ clientId: "client", clientName: "Client", redirectUris: [] });
        now = 300_001;
        assert.equal((await service.get(request.approvalId))?.status, "expired");
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("expired OAuth registration can be requested again for the same client", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "portable-devshell-oauth-registration-retry-"));
    let now = 0;
    const service = new McpOAuthApprovalService(storageDir, { now: () => now, timeoutMs: 300_000 });

    try {
        await service.warmup();
        const first = await service.registerClient({ clientId: "chatgpt", clientName: "ChatGPT", redirectUris: [] });
        now = 300_001;
        const second = await service.registerClient({ clientId: "chatgpt", clientName: "ChatGPT", redirectUris: [] });

        assert.equal((await service.get(first.approvalId))?.status, "expired");
        assert.notEqual(second.approvalId, first.approvalId);
        assert.equal(second.kind, "registration");
        assert.equal(second.status, "pending");
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});
