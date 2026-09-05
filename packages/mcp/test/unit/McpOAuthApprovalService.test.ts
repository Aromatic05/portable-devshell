import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { McpOAuthApprovalService } from "../../src/auth/oauth/McpOAuthApprovalService.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("OAuth approvals persist registration and authorization decisions", async () => {
    const storageDir = await createTestTempDirectory("oauth-approvals");
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
        const authorization = await service.requestAuthorization("interaction-1", "transaction-1", {
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

test("one OAuth authorization transaction shares approval across login and consent interactions", async () => {
    const storageDir = await createTestTempDirectory("oauth-shared-authorization");
    const service = new McpOAuthApprovalService(storageDir);

    try {
        await service.warmup();
        const registration = await service.registerClient({
            clientId: "chatgpt",
            clientName: "ChatGPT",
            redirectUris: ["https://chatgpt.com/callback"]
        });
        await service.decide(registration.approvalId, "approve", "tui");

        const login = await service.requestAuthorization("login-interaction", "pkce-flow-1", {
            clientId: "chatgpt",
            clientName: "ChatGPT",
            redirectUris: ["https://chatgpt.com/callback"],
            requestedResources: ["https://example.test/demo/mcp"],
            requestedScopes: ["openid", "mcp"]
        });
        await service.decide(login.approvalId, "approve", "tui");
        const consent = await service.requestAuthorization("consent-interaction", "pkce-flow-1", {
            clientId: "chatgpt",
            clientName: "ChatGPT",
            redirectUris: ["https://chatgpt.com/callback"],
            requestedResources: ["https://example.test/demo/mcp"],
            requestedScopes: ["openid", "mcp"]
        });

        assert.equal(consent.approvalId, login.approvalId);
        assert.equal(consent.status, "approved");
        assert.equal((await service.getAuthorization("consent-interaction"))?.approvalId, login.approvalId);
        assert.equal((await service.list()).filter((request) => request.kind === "authorization").length, 1);
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("OAuth approval reuse is bound to the complete authorization request", async () => {
    const storageDir = await createTestTempDirectory("oauth-request-binding");
    const service = new McpOAuthApprovalService(storageDir);

    try {
        await service.warmup();
        const registration = await service.registerClient({
            clientId: "chatgpt",
            clientName: "ChatGPT",
            redirectUris: ["https://chatgpt.com/callback"]
        });
        await service.decide(registration.approvalId, "approve", "tui");

        const read = await service.requestAuthorization("read-login", "shared-pkce", {
            clientId: "chatgpt",
            clientName: "ChatGPT",
            redirectUris: ["https://chatgpt.com/callback"],
            requestedResources: ["https://example.test/read/mcp"],
            requestedScopes: ["openid", "read"]
        });
        await service.decide(read.approvalId, "approve", "tui");

        const manage = await service.requestAuthorization("manage-login", "shared-pkce", {
            clientId: "chatgpt",
            clientName: "ChatGPT",
            redirectUris: ["https://chatgpt.com/other-callback"],
            requestedResources: ["https://example.test/admin/mcp"],
            requestedScopes: ["openid", "manage"]
        });

        assert.notEqual(manage.approvalId, read.approvalId);
        assert.equal(manage.status, "pending");
        assert.equal((await service.list()).filter((request) => request.kind === "authorization").length, 2);
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("completed OAuth authorization transactions cannot reuse a prior approval", async () => {
    const storageDir = await createTestTempDirectory("oauth-transaction-complete");
    const service = new McpOAuthApprovalService(storageDir);

    try {
        await service.warmup();
        const registration = await service.registerClient({
            clientId: "chatgpt",
            clientName: "ChatGPT",
            redirectUris: ["https://chatgpt.com/callback"]
        });
        await service.decide(registration.approvalId, "approve", "tui");
        const input = {
            clientId: "chatgpt",
            clientName: "ChatGPT",
            redirectUris: ["https://chatgpt.com/callback"],
            requestedResources: ["https://example.test/demo/mcp"],
            requestedScopes: ["openid", "mcp"]
        };

        const first = await service.requestAuthorization("login-1", "pkce-flow-1", input);
        await service.decide(first.approvalId, "approve", "tui");
        const consent = await service.requestAuthorization("consent-1", "pkce-flow-1", input);
        assert.equal(consent.approvalId, first.approvalId);
        await service.completeAuthorization("consent-1");

        const replay = await service.requestAuthorization("login-2", "pkce-flow-1", input);
        assert.notEqual(replay.approvalId, first.approvalId);
        assert.equal(replay.status, "pending");
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("OAuth approvals expire after five-minute policy is exceeded", async () => {
    const storageDir = await createTestTempDirectory("oauth-approval-expiry");
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
    const storageDir = await createTestTempDirectory("oauth-registration-retry");
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

test("OAuth approvals enforce a pending registration quota", async () => {
    const storageDir = await createTestTempDirectory("oauth-registration-limit");
    const service = new McpOAuthApprovalService(storageDir, { maxPendingRegistrations: 2 });

    try {
        await service.warmup();
        await service.registerClient({ clientId: "client-a", clientName: "A", redirectUris: [] });
        await service.registerClient({ clientId: "client-b", clientName: "B", redirectUris: [] });
        await assert.rejects(
            service.registerClient({ clientId: "client-c", clientName: "C", redirectUris: [] }),
            /pending OAuth registration limit/u
        );
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("OAuth approvals bound terminal authorization history without removing approved registrations or pending requests", async () => {
    const storageDir = await createTestTempDirectory("oauth-terminal-history");
    const service = new McpOAuthApprovalService(storageDir, { maxTerminalEntries: 2 });

    try {
        await service.warmup();
        const registration = await service.registerClient({
            clientId: "chatgpt",
            clientName: "ChatGPT",
            redirectUris: ["https://chatgpt.com/callback"]
        });
        await service.decide(registration.approvalId, "approve", "tui");

        const terminalIds: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            const interactionId = `interaction-${index}`;
            const authorization = await service.requestAuthorization(interactionId, `transaction-${index}`, {
                clientId: "chatgpt",
                clientName: "ChatGPT",
                redirectUris: ["https://chatgpt.com/callback"],
                requestedScopes: [`scope-${index}`]
            });
            terminalIds.push(authorization.approvalId);
            await service.decide(authorization.approvalId, "approve", "tui");
            await service.completeAuthorization(interactionId);
        }

        const pending = await service.requestAuthorization("interaction-pending", "transaction-pending", {
            clientId: "chatgpt",
            clientName: "ChatGPT",
            redirectUris: ["https://chatgpt.com/callback"],
            requestedScopes: ["pending"]
        });
        const approvals = await service.list();

        assert.equal(approvals.some((request) => request.approvalId === registration.approvalId), true);
        assert.equal(approvals.some((request) => request.approvalId === pending.approvalId && request.status === "pending"), true);
        assert.equal(approvals.some((request) => request.approvalId === terminalIds[0]), false);
        assert.equal(approvals.some((request) => request.approvalId === terminalIds[1]), true);
        assert.equal(approvals.some((request) => request.approvalId === terminalIds[2]), true);
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("OAuth approvals reject oversized persisted input before mutating state", async () => {
    const storageDir = await createTestTempDirectory("oauth-input-limit");
    const service = new McpOAuthApprovalService(storageDir, { maxInputBytes: 128 });

    try {
        await service.warmup();
        await assert.rejects(
            service.registerClient({
                clientId: "oversized",
                clientName: "x".repeat(512),
                redirectUris: ["https://example.test/callback"]
            }),
            /storage limit/u
        );
        assert.deepEqual(await service.list(), []);
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("OAuth approval memory rolls back when a decision cannot be persisted", async () => {
    const storageDir = await createTestTempDirectory("oauth-decision-rollback");
    const service = new McpOAuthApprovalService(storageDir);

    try {
        await service.warmup();
        const request = await service.registerClient({
            clientId: "rollback-client",
            clientName: "Rollback Client",
            redirectUris: []
        });
        const approvalFile = join(storageDir, "approvals.jsonl");
        await rm(approvalFile, { force: true });
        await mkdir(approvalFile);

        await assert.rejects(
            service.decide(request.approvalId, "approve", "cli")
        );
        assert.equal((await service.get(request.approvalId))?.status, "pending");
    } finally {
        await rm(storageDir, { force: true, recursive: true });
    }
});
