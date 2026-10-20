import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { McpOAuthApprovalService } from "../../src/oauth/interaction/Approval.ts";
import { McpOAuthProviderRuntime } from "../../src/oauth/provider/Provider.ts";

test("OAuth provider restart preserves discovery, resource metadata, and signing keys", async (t) => {
    const storageDir = await createTestTempDirectory("oauth-restart");
    t.after(() => rm(storageDir, { recursive: true, force: true }));
    const config = {
        documentationUrl: "https://docs.example.test/mcp",
        requiredScopes: ["mcp"],
        resourceName: "restart-fixture",
    };
    const publicBaseUrl = "http://mcp.example.test/";
    const resource = new URL(`${publicBaseUrl}demo/mcp`);
    const createRuntime = () => new McpOAuthProviderRuntime({
        accountId: "restart-test-account",
        approvals: new McpOAuthApprovalService(storageDir),
        config,
        publicBaseUrl,
        storageDir,
    });
    let runtime = createRuntime();
    let release = runtime.registerResource(resource, config);
    const metadata = async (path: string) => {
        const request = new IncomingMessage(new Socket());
        request.method = "GET";
        request.url = path;
        request.headers = { host: "mcp.example.test" };
        request.httpVersionMajor = 1;
        request.httpVersionMinor = 0;
        const chunks: Buffer[] = [];
        const socket = new Duplex({
            read() {},
            write(chunk, _encoding, callback) {
                chunks.push(Buffer.from(chunk));
                callback();
            },
        });
        const response = new ServerResponse(request);
        // The in-memory Duplex supplies ServerResponse socket I/O for this isolated fixture.
        response.assignSocket(socket as Socket);
        const finished = once(response, "finish");
        runtime.provider.callback()(request, response);
        await finished;
        assert.equal(response.statusCode, 200);
        const wire = Buffer.concat(chunks).toString("utf8");
        socket.destroy();
        request.destroy();
        return JSON.parse(wire.slice(wire.indexOf("\r\n\r\n") + 4));
    };

    try {
        await runtime.warmup();
        const discovery = await metadata("/.well-known/openid-configuration");
        assert.equal(discovery.issuer, publicBaseUrl.slice(0, -1));
        assert.equal(discovery.token_endpoint, `${publicBaseUrl}token`);
        assert.ok(discovery.scopes_supported.includes("mcp"));
        const jwks = await metadata("/jwks");
        assert.equal(jwks.keys.length, 1);
        const privateKeys = await readFile(join(storageDir, "jwks.json"), "utf8");
        const protectedResource = runtime.protectedResourceMetadata(resource);
        assert.deepEqual(protectedResource, {
            authorization_servers: [publicBaseUrl.slice(0, -1)],
            resource: resource.href,
            resource_documentation: config.documentationUrl,
            resource_name: config.resourceName,
            scopes_supported: ["mcp"],
        });

        const originalProvider = runtime.provider;
        release();
        runtime = createRuntime();
        release = runtime.registerResource(resource, config);
        await runtime.warmup();
        assert.notEqual(runtime.provider, originalProvider);
        assert.deepEqual(await metadata("/.well-known/openid-configuration"), discovery);
        assert.deepEqual(await metadata("/jwks"), jwks);
        assert.deepEqual(runtime.protectedResourceMetadata(resource), protectedResource);
        assert.deepEqual(runtime.registeredResources, [resource.href]);
        assert.equal(await readFile(join(storageDir, "jwks.json"), "utf8"), privateKeys);
    } finally {
        release();
    }
});
