import assert from "node:assert/strict";
import { mkdir, rm, access, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { McpOAuthApprovalService } from "../../../src/oauth/interaction/Approval.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { McpOAuthInteraction } from "../../../src/oauth/interaction/Interaction.ts";
import { createMcpOAuthOidcFileAdapterFactory } from "../../../src/oauth/provider/Adapter.ts";
import { McpOAuthProviderRuntime } from "../../../src/oauth/provider/Provider.ts";

{
    test("OAuth approvals persist registration and authorization decisions", async () => {
        const storageDir = await createTestTempDirectory("oauth-approvals");
        const service = new McpOAuthApprovalService(storageDir);

        try {
            await service.warmup();
            const registration = await service.registerClient({
                clientId: "chatgpt",
                clientName: "ChatGPT",
                redirectUris: ["https://chatgpt.com/callback"],
            });
            assert.equal(registration.kind, "registration");
            assert.equal(registration.status, "pending");

            await service.decide(registration.approvalId, "approve", "tui");
            const authorization = await service.requestAuthorization(
                "interaction-1",
                "transaction-1",
                {
                    clientId: "chatgpt",
                    clientName: "ChatGPT",
                    redirectUris: ["https://chatgpt.com/callback"],
                    requestedResources: ["https://example.test/demo/mcp"],
                    requestedScopes: ["openid", "mcp"],
                },
            );
            assert.equal(authorization.kind, "authorization");
            assert.equal(authorization.status, "pending");

            await service.decide(authorization.approvalId, "deny", "tui");

            const reloaded = new McpOAuthApprovalService(storageDir);
            await reloaded.warmup();
            assert.deepEqual(
                (await reloaded.list()).map((request) => [
                    request.kind,
                    request.status,
                ]),
                [
                    ["authorization", "denied"],
                    ["registration", "approved"],
                ],
            );
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("one OAuth authorization transaction shares approval across login and consent interactions", async () => {
        const storageDir = await createTestTempDirectory(
            "oauth-shared-authorization",
        );
        const service = new McpOAuthApprovalService(storageDir);

        try {
            await service.warmup();
            const registration = await service.registerClient({
                clientId: "chatgpt",
                clientName: "ChatGPT",
                redirectUris: ["https://chatgpt.com/callback"],
            });
            await service.decide(registration.approvalId, "approve", "tui");

            const login = await service.requestAuthorization(
                "login-interaction",
                "pkce-flow-1",
                {
                    clientId: "chatgpt",
                    clientName: "ChatGPT",
                    redirectUris: ["https://chatgpt.com/callback"],
                    requestedResources: ["https://example.test/demo/mcp"],
                    requestedScopes: ["openid", "mcp"],
                },
            );
            await service.decide(login.approvalId, "approve", "tui");
            const consent = await service.requestAuthorization(
                "consent-interaction",
                "pkce-flow-1",
                {
                    clientId: "chatgpt",
                    clientName: "ChatGPT",
                    redirectUris: ["https://chatgpt.com/callback"],
                    requestedResources: ["https://example.test/demo/mcp"],
                    requestedScopes: ["openid", "mcp"],
                },
            );

            assert.equal(consent.approvalId, login.approvalId);
            assert.equal(consent.status, "approved");
            assert.equal(
                (await service.getAuthorization("consent-interaction"))
                    ?.approvalId,
                login.approvalId,
            );
            assert.equal(
                (await service.list()).filter(
                    (request) => request.kind === "authorization",
                ).length,
                1,
            );
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("OAuth approval reuse is bound to the complete authorization request", async () => {
        const storageDir = await createTestTempDirectory(
            "oauth-request-binding",
        );
        const service = new McpOAuthApprovalService(storageDir);

        try {
            await service.warmup();
            const registration = await service.registerClient({
                clientId: "chatgpt",
                clientName: "ChatGPT",
                redirectUris: ["https://chatgpt.com/callback"],
            });
            await service.decide(registration.approvalId, "approve", "tui");

            const read = await service.requestAuthorization(
                "read-login",
                "shared-pkce",
                {
                    clientId: "chatgpt",
                    clientName: "ChatGPT",
                    redirectUris: ["https://chatgpt.com/callback"],
                    requestedResources: ["https://example.test/read/mcp"],
                    requestedScopes: ["openid", "read"],
                },
            );
            await service.decide(read.approvalId, "approve", "tui");

            const manage = await service.requestAuthorization(
                "manage-login",
                "shared-pkce",
                {
                    clientId: "chatgpt",
                    clientName: "ChatGPT",
                    redirectUris: ["https://chatgpt.com/other-callback"],
                    requestedResources: ["https://example.test/admin/mcp"],
                    requestedScopes: ["openid", "manage"],
                },
            );

            assert.notEqual(manage.approvalId, read.approvalId);
            assert.equal(manage.status, "pending");
            assert.equal(
                (await service.list()).filter(
                    (request) => request.kind === "authorization",
                ).length,
                2,
            );
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("completed OAuth authorization transactions cannot reuse a prior approval", async () => {
        const storageDir = await createTestTempDirectory(
            "oauth-transaction-complete",
        );
        const service = new McpOAuthApprovalService(storageDir);

        try {
            await service.warmup();
            const registration = await service.registerClient({
                clientId: "chatgpt",
                clientName: "ChatGPT",
                redirectUris: ["https://chatgpt.com/callback"],
            });
            await service.decide(registration.approvalId, "approve", "tui");
            const input = {
                clientId: "chatgpt",
                clientName: "ChatGPT",
                redirectUris: ["https://chatgpt.com/callback"],
                requestedResources: ["https://example.test/demo/mcp"],
                requestedScopes: ["openid", "mcp"],
            };

            const first = await service.requestAuthorization(
                "login-1",
                "pkce-flow-1",
                input,
            );
            await service.decide(first.approvalId, "approve", "tui");
            const consent = await service.requestAuthorization(
                "consent-1",
                "pkce-flow-1",
                input,
            );
            assert.equal(consent.approvalId, first.approvalId);
            await service.completeAuthorization("consent-1");

            const replay = await service.requestAuthorization(
                "login-2",
                "pkce-flow-1",
                input,
            );
            assert.notEqual(replay.approvalId, first.approvalId);
            assert.equal(replay.status, "pending");
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("OAuth approvals expire after five-minute policy is exceeded", async () => {
        const storageDir = await createTestTempDirectory(
            "oauth-approval-expiry",
        );
        let now = 0;
        const service = new McpOAuthApprovalService(storageDir, {
            now: () => now,
            timeoutMs: 300_000,
        });

        try {
            await service.warmup();
            const request = await service.registerClient({
                clientId: "client",
                clientName: "Client",
                redirectUris: [],
            });
            now = 300_001;
            assert.equal(
                (await service.get(request.approvalId))?.status,
                "expired",
            );
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("expired OAuth registration can be requested again for the same client", async () => {
        const storageDir = await createTestTempDirectory(
            "oauth-registration-retry",
        );
        let now = 0;
        const service = new McpOAuthApprovalService(storageDir, {
            now: () => now,
            timeoutMs: 300_000,
        });

        try {
            await service.warmup();
            const first = await service.registerClient({
                clientId: "chatgpt",
                clientName: "ChatGPT",
                redirectUris: [],
            });
            now = 300_001;
            const second = await service.registerClient({
                clientId: "chatgpt",
                clientName: "ChatGPT",
                redirectUris: [],
            });

            assert.equal(
                (await service.get(first.approvalId))?.status,
                "expired",
            );
            assert.notEqual(second.approvalId, first.approvalId);
            assert.equal(second.kind, "registration");
            assert.equal(second.status, "pending");
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("OAuth approvals enforce a pending registration quota", async () => {
        const storageDir = await createTestTempDirectory(
            "oauth-registration-limit",
        );
        const service = new McpOAuthApprovalService(storageDir, {
            maxPendingRegistrations: 2,
        });

        try {
            await service.warmup();
            await service.registerClient({
                clientId: "client-a",
                clientName: "A",
                redirectUris: [],
            });
            await service.registerClient({
                clientId: "client-b",
                clientName: "B",
                redirectUris: [],
            });
            await assert.rejects(
                service.registerClient({
                    clientId: "client-c",
                    clientName: "C",
                    redirectUris: [],
                }),
                /pending OAuth registration limit/u,
            );
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("OAuth approvals bound terminal authorization history without removing approved registrations or pending requests", async () => {
        const storageDir = await createTestTempDirectory(
            "oauth-terminal-history",
        );
        const service = new McpOAuthApprovalService(storageDir, {
            maxTerminalEntries: 2,
        });

        try {
            await service.warmup();
            const registration = await service.registerClient({
                clientId: "chatgpt",
                clientName: "ChatGPT",
                redirectUris: ["https://chatgpt.com/callback"],
            });
            await service.decide(registration.approvalId, "approve", "tui");

            const terminalIds: string[] = [];
            for (let index = 0; index < 3; index += 1) {
                const interactionId = `interaction-${index}`;
                const authorization = await service.requestAuthorization(
                    interactionId,
                    `transaction-${index}`,
                    {
                        clientId: "chatgpt",
                        clientName: "ChatGPT",
                        redirectUris: ["https://chatgpt.com/callback"],
                        requestedScopes: [`scope-${index}`],
                    },
                );
                terminalIds.push(authorization.approvalId);
                await service.decide(
                    authorization.approvalId,
                    "approve",
                    "tui",
                );
                await service.completeAuthorization(interactionId);
            }

            const pending = await service.requestAuthorization(
                "interaction-pending",
                "transaction-pending",
                {
                    clientId: "chatgpt",
                    clientName: "ChatGPT",
                    redirectUris: ["https://chatgpt.com/callback"],
                    requestedScopes: ["pending"],
                },
            );
            const approvals = await service.list();

            assert.equal(
                approvals.some(
                    (request) => request.approvalId === registration.approvalId,
                ),
                true,
            );
            assert.equal(
                approvals.some(
                    (request) =>
                        request.approvalId === pending.approvalId &&
                        request.status === "pending",
                ),
                true,
            );
            assert.equal(
                approvals.some(
                    (request) => request.approvalId === terminalIds[0],
                ),
                false,
            );
            assert.equal(
                approvals.some(
                    (request) => request.approvalId === terminalIds[1],
                ),
                true,
            );
            assert.equal(
                approvals.some(
                    (request) => request.approvalId === terminalIds[2],
                ),
                true,
            );
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("OAuth approvals reject oversized persisted input before mutating state", async () => {
        const storageDir = await createTestTempDirectory("oauth-input-limit");
        const service = new McpOAuthApprovalService(storageDir, {
            maxInputBytes: 128,
        });

        try {
            await service.warmup();
            await assert.rejects(
                service.registerClient({
                    clientId: "oversized",
                    clientName: "x".repeat(512),
                    redirectUris: ["https://example.test/callback"],
                }),
                /storage limit/u,
            );
            assert.deepEqual(await service.list(), []);
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("OAuth approval memory rolls back when a decision cannot be persisted", async () => {
        const storageDir = await createTestTempDirectory(
            "oauth-decision-rollback",
        );
        const service = new McpOAuthApprovalService(storageDir);

        try {
            await service.warmup();
            const request = await service.registerClient({
                clientId: "rollback-client",
                clientName: "Rollback Client",
                redirectUris: [],
            });
            const approvalFile = join(storageDir, "approvals.jsonl");
            await rm(approvalFile, { force: true });
            await mkdir(approvalFile);

            await assert.rejects(
                service.decide(request.approvalId, "approve", "cli"),
            );
            assert.equal(
                (await service.get(request.approvalId))?.status,
                "pending",
            );
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });
}

{
    const execFileAsync = promisify(execFile);

    const config = {
        documentationUrl: "https://docs.example.test/aromatic",
        requiredScopes: ["mcp"],
        resourceName: "aromatic",
    };

    test("OAuth Resource registrations are reference-counted across overlapping Host generations", () => {
        const storageDir = "/virtual/oauth-resource-references";
        const runtime = new McpOAuthProviderRuntime({
            approvals: new McpOAuthApprovalService(storageDir),
            config,
            publicBaseUrl: "https://mcp.example.test/",
            storageDir,
        });
        const oldUrl = new URL("https://mcp.example.test/old/demo/mcp");
        const newUrl = new URL("https://mcp.example.test/new/demo/mcp");
        const oldFirst = runtime.registerResource(oldUrl, config);
        const oldSecond = runtime.registerResource(oldUrl, config);
        const newer = runtime.registerResource(newUrl, config);
        assert.deepEqual(runtime.registeredResources, [oldUrl.href, newUrl.href]);

        // Retiring an older generation must not unregister its successor.
        oldFirst();
        oldFirst();
        assert.deepEqual(runtime.registeredResources, [oldUrl.href, newUrl.href]);
        newer();
        assert.deepEqual(runtime.registeredResources, [oldUrl.href]);
        oldSecond();
        oldSecond();
        assert.deepEqual(runtime.registeredResources, []);

        const restored = runtime.registerResource(newUrl, config);
        assert.deepEqual(runtime.registeredResources, [newUrl.href]);
        restored();
        assert.deepEqual(runtime.registeredResources, []);
    });

    test("McpOAuthProviderRuntime owns provider lifecycle, resources, metadata, and durable signing keys", async () => {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-provider-runtime",
        );
        const approvals = new McpOAuthApprovalService(storageDir);
        const runtime = new McpOAuthProviderRuntime({
            approvals,
            config,
            publicBaseUrl: "https://mcp.example.test/devshell/",
            storageDir,
            trustProxy: true,
        });

        try {
            runtime.registerResource(
                new URL("https://mcp.example.test/devshell/demo/mcp"),
                config,
            );
            await runtime.warmup();

            assert.equal(runtime.basePath, "/devshell");
            assert.equal(
                runtime.issuerUrl.href,
                "https://mcp.example.test/devshell/",
            );
            assert.equal(runtime.provider.proxy, true);
            assert.equal(
                runtime.shouldHandleProviderPath(
                    "/.well-known/openid-configuration",
                ),
                true,
            );
            assert.equal(
                runtime.shouldHandleProviderPath(
                    "/.well-known/oauth-protected-resource/devshell/demo/mcp",
                ),
                false,
            );
            assert.equal(
                runtime.shouldHandleProviderPath("/devshell/authorize"),
                true,
            );
            assert.equal(runtime.shouldHandleProviderPath("/unrelated"), false);
            assert.deepEqual(
                runtime.protectedResourceMetadata(
                    new URL("https://mcp.example.test/devshell/demo/mcp"),
                ),
                {
                    authorization_servers: [
                        "https://mcp.example.test/devshell",
                    ],
                    resource: "https://mcp.example.test/devshell/demo/mcp",
                    resource_documentation:
                        "https://docs.example.test/aromatic",
                    resource_name: "aromatic",
                    scopes_supported: ["mcp"],
                },
            );

            const firstJwks = await readFile(
                join(storageDir, "jwks.json"),
                "utf8",
            );
            if (process.platform !== "win32") {
                assert.equal(
                    (await stat(join(storageDir, "jwks.json"))).mode & 0o777,
                    0o600,
                );
            }
            const reloaded = new McpOAuthProviderRuntime({
                approvals: new McpOAuthApprovalService(storageDir),
                config,
                publicBaseUrl: "https://mcp.example.test/devshell/",
                storageDir,
                trustProxy: false,
            });
            reloaded.registerResource(
                new URL("https://mcp.example.test/devshell/demo/mcp"),
                config,
            );
            await reloaded.warmup();
            const secondJwks = await readFile(
                join(storageDir, "jwks.json"),
                "utf8",
            );
            assert.equal(secondJwks, firstJwks);
            assert.equal(reloaded.provider.proxy, false);
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("McpOAuthProviderRuntime fails closed before creating provider secrets when storage hardening fails", async () => {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-storage-security-failure",
        );
        const runtime = new McpOAuthProviderRuntime({
            approvals: new McpOAuthApprovalService(storageDir),
            config,
            publicBaseUrl: "https://mcp.example.test/",
            storageDir,
            storageSecurity: {
                async secureStorage() {
                    throw new Error("storage hardening failed");
                },
                async secureFile() {},
            },
        });

        try {
            await assert.rejects(
                runtime.warmup(),
                /storage hardening failed/iu,
            );
            assert.throws(() => runtime.provider, /not initialized/iu);
            await assert.rejects(
                access(join(storageDir, "jwks.json")),
                (error: unknown) =>
                    (error as NodeJS.ErrnoException).code === "ENOENT",
            );
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test(
        "MCP OAuth storage uses owner-only Windows ACLs",
        {
            skip:
                process.platform === "win32"
                    ? false
                    : "requires Windows DACL semantics",
        },
        async () => {
            const storageDir = await createTestTempDirectory(
                "mcp-oauth-windows-acl",
            );
            const runtime = new McpOAuthProviderRuntime({
                approvals: new McpOAuthApprovalService(storageDir),
                config,
                publicBaseUrl: "https://mcp.example.test/",
                storageDir,
            });
            const resource = new URL("https://mcp.example.test/demo/mcp");
            runtime.registerResource(resource, config);

            try {
                await runtime.warmup();
                const adapter = runtime.provider.AccessToken.adapter as {
                    upsert(
                        id: string,
                        payload: Record<string, unknown>,
                        expiresIn: number,
                    ): Promise<void>;
                };
                const now = Math.floor(Date.now() / 1000);
                await adapter.upsert(
                    "windows-acl-token",
                    {
                        aud: resource.href,
                        clientId: "windows-acl-client",
                        exp: now + 3600,
                        grantId: "windows-acl-grant",
                        iat: now,
                        kind: "AccessToken",
                        scope: "mcp",
                    },
                    3600,
                );

                assertOwnerOnlyWindowsAcl(
                    await readWindowsAcl(storageDir),
                    true,
                );
                assertOwnerOnlyWindowsAcl(
                    await readWindowsAcl(join(storageDir, "jwks.json")),
                    false,
                );
                assertOwnerOnlyWindowsAcl(
                    await readWindowsAcl(join(storageDir, "adapter")),
                    false,
                );
                assertOwnerOnlyWindowsAcl(
                    await readWindowsAcl(
                        join(storageDir, "adapter", "AccessToken.json"),
                    ),
                    false,
                );
            } finally {
                await rm(storageDir, { force: true, recursive: true });
            }
        },
    );

    test("McpOAuthProviderRuntime preserves persisted client scopes without dynamic scope inflation", async () => {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-legacy-client-scope",
        );
        const adapterDir = join(storageDir, "adapter");
        const clientFile = join(adapterDir, "Client.json");
        await mkdir(adapterDir, { recursive: true });
        await writeFile(
            clientFile,
            JSON.stringify({
                "claude-code": {
                    payload: {
                        application_type: "native",
                        client_id: "claude-code",
                        client_name: "Claude Code",
                        grant_types: ["authorization_code", "refresh_token"],
                        redirect_uris: ["http://localhost/callback"],
                        response_types: ["code"],
                        scope: "openid offline_access",
                        token_endpoint_auth_method: "none",
                    },
                },
            }),
            "utf8",
        );
        const runtime = new McpOAuthProviderRuntime({
            approvals: new McpOAuthApprovalService(storageDir),
            config,
            publicBaseUrl: "https://mcp.example.test/",
            storageDir,
        });

        try {
            await runtime.warmup();
            const client = await runtime.provider.Client.find("claude-code");
            assert.notEqual(client, undefined);
            assert.deepEqual(
                new Set(client!.scope?.split(" ")),
                new Set(["openid", "offline_access"]),
            );
            const persisted = JSON.parse(
                await readFile(clientFile, "utf8"),
            ) as {
                "claude-code": { payload: { scope?: string } };
            };
            assert.equal(
                persisted["claude-code"].payload.scope,
                "openid offline_access",
                "persisted client scopes must not be widened to the resource scopes",
            );
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("OAuth provider discovery advertises Client ID Metadata Documents without a registration endpoint", async () => {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-cimd-discovery",
        );
        const runtime = new McpOAuthProviderRuntime({
            approvals: new McpOAuthApprovalService(storageDir),
            config,
            publicBaseUrl: "https://mcp.example.test/",
            storageDir,
        });
        const server = await startCallbackServer(runtime);

        try {
            assert.equal(runtime.shouldHandleProviderPath("/register"), false);
            assert.equal(
                runtime.shouldHandleProviderPath("/.well-known/oauth-protected-resource/x"),
                false,
            );
            assert.equal(runtime.shouldHandleProviderPath("/token"), true);

            const discovery = await fetch(
                `${server.origin}/.well-known/openid-configuration`,
            );
            assert.equal(discovery.status, 200);
            const metadata = (await discovery.json()) as Record<string, unknown>;
            assert.equal(
                metadata.client_id_metadata_document_supported,
                true,
            );
            assert.equal("registration_endpoint" in metadata, false);

            const register = await fetch(`${server.origin}/register`, {
                body: JSON.stringify({
                    redirect_uris: ["https://client.example.test/callback"],
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            });
            assert.equal(register.status, 404);
            assert.equal(
                (await fetch(`${server.origin}/register/some-client`)).status,
                404,
            );
        } finally {
            await server.close();
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("Client ID Metadata Documents resolve unregistered clients without persisting them", async () => {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-cimd-resolve",
        );
        const clientId = "https://client.example.test/oauth/client-metadata.json";
        const document = {
            client_id: clientId,
            client_name: "ChatGPT",
            redirect_uris: [
                "https://chatgpt.com/connector_platform_oauth_redirect",
            ],
            token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
        };
        const runtime = new McpOAuthProviderRuntime({
            approvals: new McpOAuthApprovalService(storageDir),
            config,
            fetch: cimdFetchFor(
                clientId,
                () => jsonDocumentResponse(document),
            ),
            publicBaseUrl: "https://mcp.example.test/",
            storageDir,
        });

        try {
            await runtime.warmup();
            const client = await runtime.provider.Client.find(clientId);
            assert.notEqual(client, undefined);
            assert.equal(client!.clientName, "ChatGPT");
            assert.equal(client!.tokenEndpointAuthMethod, "none");
            assert.deepEqual(
                new Set(client!.grantTypes),
                new Set(["authorization_code", "refresh_token"]),
            );
            assert.ok(
                (client!.redirectUris ?? []).includes(
                    "https://chatgpt.com/connector_platform_oauth_redirect",
                ),
            );
            await assert.rejects(
                access(join(storageDir, "adapter", "Client.json")),
                (error: unknown) =>
                    (error as NodeJS.ErrnoException).code === "ENOENT",
            );
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("Client ID Metadata Document validation rejects unsafe or invalid documents", async () => {
        const clientId = "https://client.example.test/metadata.json";
        const validDocument = (overrides: Record<string, unknown> = {}) => ({
            client_id: clientId,
            client_name: "Example Client",
            redirect_uris: ["https://client.example.test/callback"],
            ...overrides,
        });

        await assert.rejects(
            findCimdClient(
                clientId,
                () =>
                    jsonDocumentResponse(
                        validDocument({
                            client_id: "https://evil.example.test/metadata.json",
                        }),
                    ),
            ),
            /client_id|metadata/iu,
        );
        await assert.rejects(
            findCimdClient(
                clientId,
                () =>
                    new Response("not json", {
                        headers: { "content-type": "application/json" },
                        status: 200,
                    }),
            ),
            /invalid_client|metadata|fetch/iu,
        );
        await assert.rejects(
            findCimdClient(clientId, () =>
                jsonDocumentResponse(
                    validDocument({ padding: "x".repeat(6 * 1024) }),
                ),
            ),
            /invalid_client|metadata|fetch/iu,
        );
        await assert.rejects(
            findCimdClient(
                clientId,
                () =>
                    new Response("", {
                        headers: { location: "https://elsewhere.example.test/" },
                        status: 302,
                    }),
            ),
            /invalid_client|metadata|fetch/iu,
        );
        await assert.rejects(
            findCimdClient(clientId, () =>
                jsonDocumentResponse(
                    validDocument({
                        token_endpoint_auth_method: "client_secret_basic",
                    }),
                ),
            ),
            /metadata|secret/iu,
        );
        await assert.rejects(
            findCimdClient(clientId, () =>
                jsonDocumentResponse(validDocument({ client_secret: "s3cr3t" })),
            ),
            /invalid_client|secret/iu,
        );
        await assert.rejects(
            findCimdClient(clientId, () =>
                jsonDocumentResponse(
                    validDocument({
                        client_uri: "http://client.example.test/",
                    }),
                ),
            ),
            /metadata|https/iu,
        );
        await assert.rejects(
            findCimdClient(`${clientId}?probe=1`, () =>
                jsonDocumentResponse(
                    validDocument({ client_id: `${clientId}?probe=1` }),
                ),
            ),
            /allowed|client/iu,
        );
    });

    test("Client ID Metadata Document fetch must reject loopback addresses via socket-level SSRF protection", async () => {
        const storageDir = await createTestTempDirectory("mcp-oauth-cimd-ssrf");
        const local = createServer((_request, response) => response.end("{}"));
        await new Promise<void>((resolve, reject) => {
            local.once("error", reject);
            local.listen(0, "127.0.0.1", resolve);
        });
        const address = local.address();
        if (address === null || typeof address === "string") {
            throw new Error("SSRF probe server did not expose a TCP address.");
        }
        const clientId = `https://127.0.0.1:${address.port}/metadata.json`;
        const runtime = new McpOAuthProviderRuntime({
            approvals: new McpOAuthApprovalService(storageDir),
            config,
            publicBaseUrl: "https://mcp.example.test/",
            storageDir,
        });

        try {
            await runtime.warmup();
            // BLOCKER (reported, not waived): oidc-provider 9.12.2 derives its
            // SSRF Agent from undici's global dispatcher and destroys the socket
            // on the Agent "connect" event. On Node 24 that event does not fire
            // for HTTPS connections, so the loopback fetch proceeds to TLS and
            // the guard is inert. This assertion is intentionally strict; do not
            // relax it to a bare rejection, which a TLS failure would satisfy.
            await assert.rejects(
                runtime.provider.Client.find(clientId),
                (error: unknown) => {
                    let cursor: unknown = error;
                    for (
                        let depth = 0;
                        depth < 8 && cursor instanceof Error;
                        depth += 1
                    ) {
                        if (/special-use|SSRF/iu.test(cursor.message)) {
                            return true;
                        }
                        cursor = cursor.cause;
                    }
                    return false;
                },
            );
        } finally {
            await new Promise<void>((resolve, reject) =>
                local.close((error) =>
                    error === undefined ? resolve() : reject(error),
                ),
            );
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("Client ID Metadata Document scope is enforced strictly at authorization", async () => {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-cimd-scope",
        );
        const clientId = "https://client.example.test/scope-metadata.json";
        const redirectUri = "https://client.example.test/callback";
        const runtime = new McpOAuthProviderRuntime({
            approvals: new McpOAuthApprovalService(storageDir),
            config,
            fetch: cimdFetchFor(clientId, () =>
                jsonDocumentResponse({
                    client_id: clientId,
                    client_name: "Narrow Client",
                    redirect_uris: [redirectUri],
                    scope: "openid",
                }),
            ),
            publicBaseUrl: "https://mcp.example.test/",
            storageDir,
        });
        const server = await startCallbackServer(runtime);

        try {
            const authorize = new URL(`${server.origin}/authorize`);
            for (const [name, value] of Object.entries({
                client_id: clientId,
                code_challenge: "B".repeat(43),
                code_challenge_method: "S256",
                redirect_uri: redirectUri,
                response_type: "code",
                scope: "openid mcp",
                state: "narrow-scope-state",
            })) {
                authorize.searchParams.set(name, value);
            }

            const response = await fetch(authorize, { redirect: "manual" });
            assert.equal(response.status, 303);
            const location = response.headers.get("location") ?? "";
            assert.match(location, /error=invalid_scope/u);
        } finally {
            await server.close();
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("OAuth interaction reports approval capacity exhaustion with 429", async () => {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-cimd-capacity",
        );
        const clientId = "https://client.example.test/capacity-metadata.json";
        const redirectUri = "https://client.example.test/callback";
        const approvals = new McpOAuthApprovalService(storageDir, {
            maxPendingRegistrations: 1,
        });
        const runtime = new McpOAuthProviderRuntime({
            approvals,
            config,
            fetch: cimdFetchFor(clientId, () =>
                jsonDocumentResponse({
                    client_id: clientId,
                    client_name: "Capacity Client",
                    redirect_uris: [redirectUri],
                }),
            ),
            publicBaseUrl: "https://mcp.example.test/",
            storageDir,
        });
        runtime.registerResource(
            new URL("https://mcp.example.test/capacity/mcp"),
            config,
        );
        await runtime.warmup();
        const interaction = new McpOAuthInteraction({
            accountId: "aromatic",
            approval: { mode: "tui" },
            approvals,
            basePath: "",
            provider: () => runtime.provider,
        });
        const app = express();
        interaction.install(app);
        app.use((request, response, next) => {
            const pathname = new URL(
                request.url ?? "/",
                "http://127.0.0.1",
            ).pathname;
            if (runtime.shouldHandleProviderPath(pathname)) {
                runtime.provider.callback()(request, response);
                return;
            }
            next();
        });
        const server = createServer(app);
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error(
                "OAuth capacity test server did not expose a TCP address.",
            );
        }
        const origin = `http://127.0.0.1:${address.port}`;

        try {
            await approvals.registerClient({
                clientId: "pending-client",
                clientName: "Pending Client",
                redirectUris: ["https://pending.example.test/callback"],
            });

            const authorize = new URL(`${origin}/authorize`);
            for (const [name, value] of Object.entries({
                client_id: clientId,
                code_challenge: "B".repeat(43),
                code_challenge_method: "S256",
                redirect_uri: redirectUri,
                resource: "https://mcp.example.test/capacity/mcp",
                response_type: "code",
                scope: "openid",
                state: "capacity-state",
            })) {
                authorize.searchParams.set(name, value);
            }
            const authResponse = await fetch(authorize, { redirect: "manual" });
            assert.equal(authResponse.status, 303);
            const interactionUrl = new URL(
                authResponse.headers.get("location") ?? "",
                origin,
            );
            const interactionCookie = readResponseCookieHeader(authResponse.headers);

            const page = await fetch(interactionUrl, {
                headers:
                    interactionCookie.length === 0
                        ? {}
                        : { cookie: interactionCookie },
                redirect: "manual",
            });
            assert.equal(page.status, 429);
            assert.equal(page.headers.get("retry-after"), "60");
        } finally {
            await new Promise<void>((resolve, reject) =>
                server.close((error) =>
                    error === undefined ? resolve() : reject(error),
                ),
            );
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("OAuth resource verification rejects tokens with missing or malformed audience", async () => {
        const storageDir = await createTestTempDirectory("mcp-oauth-audience");
        const runtime = new McpOAuthProviderRuntime({
            approvals: new McpOAuthApprovalService(storageDir),
            config,
            publicBaseUrl: "https://mcp.example.test/",
            storageDir,
        });
        const resource = new URL("https://mcp.example.test/demo/mcp");
        runtime.registerResource(resource, config);
        await runtime.warmup();

        try {
            const adapter = runtime.provider.AccessToken.adapter as {
                upsert(
                    id: string,
                    payload: Record<string, unknown>,
                    expiresIn: number,
                ): Promise<void>;
            };
            const now = Math.floor(Date.now() / 1000);
            const base = {
                clientId: "client-audience-test",
                exp: now + 3600,
                iat: now,
                kind: "AccessToken",
                scope: "mcp",
            };
            await adapter.upsert("missing-audience", base, 3600);
            await adapter.upsert(
                "malformed-audience",
                { ...base, aud: "not a URL" },
                3600,
            );

            await assert.rejects(
                runtime.verifyAccessToken(resource, "missing-audience"),
                /resource|audience|invalid/iu,
            );
            await assert.rejects(
                runtime.verifyAccessToken(resource, "malformed-audience"),
                /resource|audience|invalid/iu,
            );
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
            storageDir,
        });
        const resource = new URL("https://mcp.example.test/demo/mcp");
        runtime.registerResource(resource, config);
        await runtime.warmup();

        try {
            const adapter = runtime.provider.AccessToken.adapter as {
                upsert(
                    id: string,
                    payload: Record<string, unknown>,
                    expiresIn: number,
                ): Promise<void>;
            };
            const now = Math.floor(Date.now() / 1000);
            await adapter.upsert(
                "insufficient-scope",
                {
                    aud: resource.href,
                    clientId: "client-scope-test",
                    exp: now + 3600,
                    iat: now,
                    kind: "AccessToken",
                    scope: "openid",
                },
                3600,
            );

            await assert.rejects(
                runtime.verifyAccessToken(resource, "insufficient-scope"),
                /scope/iu,
            );
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("OAuth provider reports destroyed access-token identity to long-lived resource listeners", async () => {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-revocation-event",
        );
        const runtime = new McpOAuthProviderRuntime({
            approvals: new McpOAuthApprovalService(storageDir),
            config,
            publicBaseUrl: "https://mcp.example.test/",
            storageDir,
        });
        const resource = new URL("https://mcp.example.test/demo/mcp");
        runtime.registerResource(resource, config);
        await runtime.warmup();
        const revocations: Array<{ grantId: string }> = [];
        const unsubscribe = runtime.onAccessRevoked((revocation) =>
            revocations.push(revocation),
        );

        try {
            const adapter = runtime.provider.AccessToken.adapter as {
                upsert(
                    id: string,
                    payload: Record<string, unknown>,
                    expiresIn: number,
                ): Promise<void>;
            };
            const now = Math.floor(Date.now() / 1000);
            await adapter.upsert(
                "revocable-access",
                {
                    aud: resource.href,
                    clientId: "client-revocation-test",
                    exp: now + 3600,
                    grantId: "grant-revocation-test",
                    iat: now,
                    kind: "AccessToken",
                    scope: "mcp",
                },
                3600,
            );
            const token =
                await runtime.provider.AccessToken.find("revocable-access");
            assert.notEqual(token, undefined);

            await token!.destroy();

            assert.deepEqual(revocations, [
                { grantId: "grant-revocation-test" },
            ]);
        } finally {
            unsubscribe();
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("McpOAuthInteraction renders escaped approval state with the configured base path", async () => {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-interaction",
        );
        const approvals = new McpOAuthApprovalService(storageDir);
        await approvals.warmup();
        const interaction = new McpOAuthInteraction({
            accountId: "aromatic<admin>",
            approval: { mode: "tui" },
            approvals,
            basePath: "/devshell",
            provider: () => {
                throw new Error("provider is not needed for rendering");
            },
        });

        try {
            const html = interaction.renderPage({
                accountId: "aromatic<admin>",
                approvalId: "approval-1",
                approvalKind: "authorization",
                approvalMode: "tui",
                approvalStatus: "pending",
                approvalTokenConfigured: false,
                clientName: "Client <script>",
                promptName: "consent",
                redirectUris: [
                    "http://127.0.0.1:33418/callback",
                    "https://app.example.test/callback?a=<b>",
                ],
                requestedResources: [
                    {
                        indicator: "https://mcp.example.test/demo/mcp?a=<b>",
                        scopes: ["mcp", "write<all>"],
                    },
                ],
                requiredScopes: ["openid", "mcp"],
            });

            assert.match(html, /Client &lt;script&gt;/u);
            assert.match(html, /aromatic&lt;admin&gt;/u);
            assert.match(html, /write&lt;all&gt;/u);
            assert.match(html, /\/devshell\/oauth\/approvals\/approval-1/u);
            assert.doesNotMatch(html, /Client <script>/u);
            assert.match(html, /127\.0\.0\.1:33418/u);
            assert.match(html, /app\.example\.test/u);
            assert.doesNotMatch(
                html,
                /client only redirects to localhost/iu,
                "a mixed redirect set is not localhost-only",
            );
            assert.match(html, /Connections → OAuth Approvals/u);
            assert.match(html, /devshell oauth approve approval-1/u);
            assert.match(html, /Waiting for approval/u);
            assert.doesNotMatch(html, /<button/u);
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("McpOAuthInteraction renders approved registration as a reload flow", async () => {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-registration-page",
        );
        const interaction = new McpOAuthInteraction({
            accountId: "aromatic",
            approval: { mode: "tui" },
            approvals: new McpOAuthApprovalService(storageDir),
            basePath: "",
            provider: () => {
                throw new Error("provider is not needed for rendering");
            },
        });

        try {
            const html = interaction.renderPage({
                accountId: "aromatic",
                approvalId: "approval-registration",
                approvalKind: "registration",
                approvalMode: "tui",
                approvalStatus: "approved",
                approvalTokenConfigured: false,
                clientName: "ChatGPT",
                promptName: "login",
                redirectUris: [],
                requestedResources: [],
                requiredScopes: [],
            });

            assert.match(html, /Approved\. Continuing/u);
            assert.match(html, /window\.location\.reload\(\)/u);
            assert.doesNotMatch(html, /fetch\(/u);
            assert.doesNotMatch(html, /<button/u);
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("McpOAuthInteraction renders a static approval token form in token mode", async () => {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-token-approval-page",
        );
        const interaction = new McpOAuthInteraction({
            accountId: "aromatic",
            approval: {
                mode: "token",
                token: "0123456789abcdef0123456789abcdef",
            },
            approvals: new McpOAuthApprovalService(storageDir),
            basePath: "",
            provider: () => {
                throw new Error("provider is not needed for rendering");
            },
        });

        try {
            const html = interaction.renderPage({
                accountId: "aromatic",
                approvalId: "approval-token",
                approvalKind: "authorization",
                approvalMode: "token",
                approvalStatus: "pending",
                approvalTokenConfigured: true,
                clientName: "ChatGPT",
                promptName: "consent",
                redirectUris: [],
                requestedResources: [],
                requiredScopes: ["mcp"],
            });

            assert.match(html, /name="approvalToken"/u);
            assert.match(html, />Approve<\/button>/u);
            assert.doesNotMatch(html, /Connections → OAuth Approvals/u);
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("McpOAuthInteraction warns when a client only uses localhost redirect URIs", async () => {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-localhost-warning",
        );
        const interaction = new McpOAuthInteraction({
            accountId: "aromatic",
            approval: { mode: "tui" },
            approvals: new McpOAuthApprovalService(storageDir),
            basePath: "",
            provider: () => {
                throw new Error("provider is not needed for rendering");
            },
        });

        try {
            const html = interaction.renderPage({
                accountId: "aromatic",
                approvalId: "approval-localhost",
                approvalKind: "authorization",
                approvalMode: "tui",
                approvalStatus: "pending",
                approvalTokenConfigured: false,
                clientName: "Local Client",
                promptName: "consent",
                redirectUris: ["http://127.0.0.1:33418/callback"],
                requestedResources: [],
                requiredScopes: ["mcp"],
            });

            assert.match(html, /127\.0\.0\.1:33418/u);
            assert.match(html, /client only redirects to localhost/iu);
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("OIDC file adapter serializes concurrent updates without losing records", async () => {
        const storageDir = await createTestTempDirectory("mcp-oauth-adapter");
        const adapter =
            createMcpOAuthOidcFileAdapterFactory(storageDir)("Client");

        try {
            await Promise.all(
                Array.from({ length: 64 }, async (_, index) => {
                    await adapter.upsert(
                        `client-${index}`,
                        { clientId: `client-${index}` } as never,
                        3600,
                    );
                }),
            );
            for (let index = 0; index < 64; index += 1) {
                assert.equal(
                    (await adapter.find(`client-${index}`))?.clientId,
                    `client-${index}`,
                );
            }
            if (process.platform !== "win32") {
                assert.equal(
                    (await stat(join(storageDir, "Client.json"))).mode & 0o777,
                    0o600,
                );
            }
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("OIDC file adapters prepare shared storage once before model writes", async () => {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-adapter-security",
        );
        const prepared: string[] = [];
        const factory = createMcpOAuthOidcFileAdapterFactory(
            storageDir,
            async (path) => {
                prepared.push(path);
            },
        );
        const clients = factory("Client");
        const tokens = factory("AccessToken");

        try {
            await clients.upsert(
                "client",
                { clientId: "client" } as never,
                3600,
            );
            await tokens.upsert(
                "token",
                { clientId: "client", kind: "AccessToken" } as never,
                3600,
            );
            await clients.upsert(
                "client-2",
                { clientId: "client-2" } as never,
                3600,
            );

            assert.deepEqual(prepared, [storageDir]);
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    test("OIDC file adapters share cached model state and invalidate it after a failed write", async () => {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-adapter-cache",
        );
        let failStorage = false;
        const secureStorage = async () => {
            if (failStorage) throw new Error("secure storage failed");
        };
        const first = createMcpOAuthOidcFileAdapterFactory(
            storageDir,
            secureStorage,
        )("AccessToken");
        const second = createMcpOAuthOidcFileAdapterFactory(
            storageDir,
            secureStorage,
        )("AccessToken");

        try {
            await first.upsert(
                "stable",
                {
                    clientId: "client-stable",
                    nested: { value: "original" },
                } as never,
                3600,
            );
            const shared = await second.find("stable");
            assert.equal(shared?.clientId, "client-stable");
            (shared as { nested?: { value?: string } }).nested!.value =
                "mutated";
            assert.equal(
                (
                    (await first.find("stable")) as {
                        nested?: { value?: string };
                    }
                )?.nested?.value,
                "original",
            );

            failStorage = true;
            await assert.rejects(
                second.upsert(
                    "failed",
                    { clientId: "client-failed" } as never,
                    3600,
                ),
                /secure storage failed/u,
            );
            failStorage = false;

            assert.equal(await first.find("failed"), undefined);
            assert.equal(
                (await second.find("stable"))?.clientId,
                "client-stable",
            );

            await Promise.all(
                Array.from({ length: 32 }, async (_, index) => {
                    const adapter = index % 2 === 0 ? first : second;
                    await adapter.upsert(
                        `shared-${index}`,
                        { clientId: `client-${index}` } as never,
                        3600,
                    );
                }),
            );
            for (let index = 0; index < 32; index += 1) {
                assert.equal(
                    (await first.find(`shared-${index}`))?.clientId,
                    `client-${index}`,
                );
            }
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    });

    function jsonDocumentResponse(
        document: Record<string, unknown>,
    ): Response {
        return new Response(JSON.stringify(document), {
            headers: { "content-type": "application/json" },
            status: 200,
        });
    }

    function cimdFetchFor(
        clientId: string,
        respond: () => Response,
    ): typeof globalThis.fetch {
        return async (input, init) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url;
            if (url === clientId) {
                return respond();
            }
            return globalThis.fetch(input, init);
        };
    }

    async function findCimdClient(
        clientId: string,
        respond: () => Response,
    ): Promise<unknown> {
        const storageDir = await createTestTempDirectory(
            "mcp-oauth-cimd-reject",
        );
        const runtime = new McpOAuthProviderRuntime({
            approvals: new McpOAuthApprovalService(storageDir),
            config,
            fetch: cimdFetchFor(clientId, respond),
            publicBaseUrl: "https://mcp.example.test/",
            storageDir,
        });
        await runtime.warmup();
        try {
            return await runtime.provider.Client.find(clientId);
        } finally {
            await rm(storageDir, { force: true, recursive: true });
        }
    }

    async function startCallbackServer(
        runtime: McpOAuthProviderRuntime,
    ): Promise<{ origin: string; close: () => Promise<void> }> {
        await runtime.warmup();
        const server = createServer(runtime.provider.callback());
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("OAuth test server did not expose a TCP address.");
        }
        return {
            origin: `http://127.0.0.1:${address.port}`,
            close: async () => {
                await new Promise<void>((resolve, reject) =>
                    server.close((error) =>
                        error === undefined ? resolve() : reject(error),
                    ),
                );
            },
        };
    }

    function readResponseCookieHeader(headers: Headers): string {
        const entries =
            typeof headers.getSetCookie === "function"
                ? headers.getSetCookie()
                : headers.get("set-cookie") === null
                  ? []
                  : [headers.get("set-cookie")!];
        return entries
            .map((entry) => entry.split(";", 1)[0]!)
            .filter((pair) => pair.length > 0)
            .join("; ");
    }

    interface WindowsAclSnapshot {
        currentSid: string;
        ownerSid: string;
        protected: boolean;
        rules: Array<{
            identitySid: string;
            inherited: boolean;
            rights: string;
            type: string;
        }>;
    }

    async function readWindowsAcl(path: string): Promise<WindowsAclSnapshot> {
        const script = [
            "$path = $env:PORTABLE_DEVSHELL_TEST_ACL_PATH",
            "$acl = if ([System.IO.Directory]::Exists($path)) { [System.IO.Directory]::GetAccessControl($path) } else { [System.IO.File]::GetAccessControl($path) }",
            "$sidType = [System.Security.Principal.SecurityIdentifier]",
            "$rules = @($acl.Access | ForEach-Object {",
            "  [pscustomobject]@{",
            "    identitySid = $_.IdentityReference.Translate($sidType).Value",
            "    inherited = $_.IsInherited",
            "    rights = $_.FileSystemRights.ToString()",
            "    type = $_.AccessControlType.ToString()",
            "  }",
            "})",
            "[pscustomobject]@{",
            "  currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
            "  ownerSid = $acl.GetOwner($sidType).Value",
            "  protected = $acl.AreAccessRulesProtected",
            "  rules = $rules",
            "} | ConvertTo-Json -Depth 4 -Compress",
        ].join("\n");
        const { stdout } = await execFileAsync(
            "powershell.exe",
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            {
                env: { ...process.env, PORTABLE_DEVSHELL_TEST_ACL_PATH: path },
                windowsHide: true,
            },
        );
        return JSON.parse(stdout) as WindowsAclSnapshot;
    }

    function assertOwnerOnlyWindowsAcl(
        snapshot: WindowsAclSnapshot,
        requireProtected: boolean,
    ): void {
        assert.equal(snapshot.ownerSid, snapshot.currentSid);
        if (requireProtected) assert.equal(snapshot.protected, true);
        assert.ok(snapshot.rules.length > 0);
        for (const rule of snapshot.rules) {
            assert.equal(rule.identitySid, snapshot.currentSid);
            assert.equal(rule.type, "Allow");
            assert.match(rule.rights, /FullControl/u);
        }
    }
}
