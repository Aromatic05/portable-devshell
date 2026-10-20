import assert from "node:assert/strict";
import test from "node:test";
import { McpOAuthProviderRuntime } from "../../../src/oauth/provider/Provider.ts";
import { McpOAuthApprovalService } from "../../../src/oauth/interaction/Approval.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { betaConfig, betaResource } from "../../support/BetaOAuth.ts";

const clientId = "https://client.example.test/metadata.json";
function metadata(name: string, id = clientId) {
    return { client_id: id, client_name: name, redirect_uris: ["https://client.example.test/callback"], scope: "mcp" };
}
function document(value: unknown, etag: string) {
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "cache-control": "max-age=3600", etag } });
}
function runtime(directory: string, fetch: typeof globalThis.fetch) {
    const result = new McpOAuthProviderRuntime({
        approvals: new McpOAuthApprovalService(directory), config: betaConfig, fetch,
        publicBaseUrl: "http://mcp.example.test/", storageDir: directory,
    });
    result.registerResource(betaResource, betaConfig);
    return result;
}

test("round3 CIMD old in-flight ETag generation cannot poison the new provider's client metadata cache", async () => {
    const directory = await createTestTempDirectory("round3-cimd-generation");
    let calls = 0;
    let releaseOld!: () => void;
    let enterOld!: () => void;
    const oldReady = new Promise<void>((resolve) => { enterOld = resolve; });
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const oauth = runtime(directory, async (input) => {
        assert.equal(String(input), clientId);
        calls++;
        if (calls === 1) {
            enterOld();
            await oldGate;
            return document(metadata("Old generation"), '"v1"');
        }
        return document(metadata("New generation"), '"v2"');
    });
    await oauth.warmup();
    const oldProvider = oauth.provider;
    const oldLookup = oldProvider.Client.find(clientId);
    await oldReady;
    try {
        const release = oauth.registerResource(new URL("http://mcp.example.test/other/mcp"), { ...betaConfig, requiredScopes: ["new-scope"] });
        assert.notEqual(oauth.provider, oldProvider);
        assert.equal((await oauth.provider.Client.find(clientId))?.clientName, "New generation");
        releaseOld();
        assert.equal((await oldLookup)?.clientName, "Old generation");
        assert.equal((await oauth.provider.Client.find(clientId))?.clientName, "New generation");
        assert.equal(calls, 2);
        release();
    } finally { releaseOld(); await oldLookup; }
});

test("round3 CIMD issuer restart rejects stale 304 and wrong-client metadata before accepting a fresh document", async () => {
    const directory = await createTestTempDirectory("round3-cimd-restart");
    const first = runtime(directory, async () => document(metadata("Before restart"), '"v1"'));
    await first.warmup();
    assert.equal((await first.provider.Client.find(clientId))?.clientName, "Before restart");
    let mode = "304";
    let calls = 0;
    const restarted = runtime(directory, async () => {
        calls++;
        if (mode === "304") return new Response(null, { status: 304, headers: { etag: '"v1"' } });
        if (mode === "wrong-client") return document(metadata("Attacker", "https://attacker.example.test/metadata.json"), '"v2"');
        return document(metadata("After restart"), '"v3"');
    });
    await restarted.warmup();
    await assert.rejects(restarted.provider.Client.find(clientId), { error: "invalid_client", error_description: "client_id metadata document fetch failed" });
    mode = "wrong-client";
    await assert.rejects(restarted.provider.Client.find(clientId), { error: "invalid_client_metadata", error_description: "client_id metadata document client_id does not match the expected value" });
    mode = "valid";
    assert.equal((await restarted.provider.Client.find(clientId))?.clientName, "After restart");
    assert.equal(calls, 3);
});
