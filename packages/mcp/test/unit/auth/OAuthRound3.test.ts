import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { betaConfig, betaOAuth, betaResource, oidcRequest, seedAccess, seedRefresh } from "../../support/BetaOAuth.ts";

test("round3 OAuth audience isolation rejects sibling, prefix, origin and malformed multi-audience substitutions", async () => {
    const runtime = betaOAuth(await createTestTempDirectory("round3-audience"));
    await runtime.warmup();
    const audiences = [
        "http://mcp.example.test/other/mcp", "http://mcp.example.test/demo/mcp-evil",
        "http://evil.example.test/demo/mcp", "https://mcp.example.test/demo/mcp",
        [betaResource.href, "not-a-resource"],
    ];
    for (const [index, aud] of audiences.entries()) {
        const id = `audience-${index}`;
        await seedAccess(runtime, id, { aud });
        await assert.rejects(runtime.verifyAccessToken(betaResource, id), /audience/iu, `audience case ${index}: ${JSON.stringify(aud)}`);
    }
    await seedAccess(runtime, "multi", { aud: ["http://mcp.example.test/other/mcp", betaResource.href] });
    assert.equal((await runtime.verifyAccessToken(betaResource, "multi")).clientId, "round3-client");
});

test("round3 OAuth latest resource scope generation wins and out-of-order release restores the remaining generation", async () => {
    const runtime = betaOAuth(await createTestTempDirectory("round3-scopes"));
    await runtime.warmup();
    await seedAccess(runtime, "old-scope");
    const releaseMiddle = runtime.registerResource(betaResource, { ...betaConfig, requiredScopes: ["middle"] });
    const releaseLatest = runtime.registerResource(betaResource, { ...betaConfig, requiredScopes: ["latest"] });
    await seedAccess(runtime, "latest-scope", { scope: "latest" });
    await assert.rejects(runtime.verifyAccessToken(betaResource, "old-scope"), /scope/iu);
    assert.deepEqual((await runtime.verifyAccessToken(betaResource, "latest-scope")).scopes, ["latest"]);
    releaseMiddle();
    await assert.rejects(runtime.verifyAccessToken(betaResource, "old-scope"), /scope/iu);
    releaseLatest();
    releaseMiddle();
    assert.deepEqual((await runtime.verifyAccessToken(betaResource, "old-scope")).scopes, ["mcp"]);
    await assert.rejects(runtime.verifyAccessToken(betaResource, "latest-scope"), /scope/iu);
});

test("round3 OAuth rejects token exp at the current second even while its adapter record remains live", async () => {
    const runtime = betaOAuth(await createTestTempDirectory("round3-expiry"));
    await runtime.warmup();
    await seedAccess(runtime, "expired", { exp: Math.floor(Date.now() / 1000) });
    assert.ok(await runtime.provider.AccessToken.adapter.find("expired"));
    await assert.rejects(runtime.verifyAccessToken(betaResource, "expired"), /expired/iu);
    await seedAccess(runtime, "live");
    assert.equal((await runtime.verifyAccessToken(betaResource, "live")).grantId, "round3-grant");
});

test("round3 OAuth first-party client identity and refresh survive issuer reconstruction without widening scope", async () => {
    const directory = await createTestTempDirectory("round3-client-restart");
    let runtime = betaOAuth(directory);
    await runtime.warmup();
    const seeded = await seedRefresh(runtime);
    const before = await readFile(join(directory, "adapter", "Client.json"), "utf8");
    runtime = betaOAuth(directory);
    await runtime.warmup();
    assert.equal(await runtime.registerFirstPartyWebClient("http://mcp.example.test/callback-a", ["mcp"]), seeded.clientId);
    assert.deepEqual(await readFile(join(directory, "adapter", "Client.json"), "utf8"), before);
    const wrongClient = await runtime.registerFirstPartyWebClient("http://mcp.example.test/callback-b", ["mcp"]);
    const wrong = await oidcRequest(runtime, "/token", { grant_type: "refresh_token", refresh_token: seeded.token, client_id: wrongClient });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, "invalid_grant");
    const expanded = await oidcRequest(runtime, "/token", { grant_type: "refresh_token", refresh_token: seeded.token, client_id: seeded.clientId, scope: "mcp admin" });
    assert.equal(expanded.status, 400);
    assert.equal(expanded.body.error, "invalid_scope");
    const correct = await oidcRequest(runtime, "/token", { grant_type: "refresh_token", refresh_token: seeded.token, client_id: seeded.clientId });
    assert.equal(correct.status, 200);
    assert.notEqual(correct.body.refresh_token, seeded.token);
    assert.equal((await runtime.verifyAccessToken(betaResource, correct.body.access_token!)).clientId, seeded.clientId);
});

test("round3 OAuth wrong-client revocation cannot revoke another client's refresh or access token", async () => {
    const runtime = betaOAuth(await createTestTempDirectory("round3-revoke-owner"));
    await runtime.warmup();
    const owner = await seedRefresh(runtime, "owner");
    const other = await seedRefresh(runtime, "other");
    const revoke = await oidcRequest(runtime, "/revoke", { token: owner.token, token_type_hint: "refresh_token", client_id: other.clientId });
    assert.equal(revoke.status, 200);
    assert.ok(await runtime.provider.RefreshToken.find(owner.token));
    const refreshed = await oidcRequest(runtime, "/token", { grant_type: "refresh_token", refresh_token: owner.token, client_id: owner.clientId });
    assert.equal(refreshed.status, 200);
    assert.equal((await runtime.verifyAccessToken(betaResource, refreshed.body.access_token!)).grantId, owner.grantId);
    const rightRevoke = await oidcRequest(runtime, "/revoke", { token: refreshed.body.refresh_token!, token_type_hint: "refresh_token", client_id: owner.clientId });
    assert.equal(rightRevoke.status, 200);
    await assert.rejects(runtime.verifyAccessToken(betaResource, refreshed.body.access_token!), /invalid|expired/iu);
    assert.ok(await runtime.provider.RefreshToken.find(other.token));
});

test("round3 OAuth sequential reuse of rotated refresh revokes the successor grant and emits its revocation identity", async () => {
    const runtime = betaOAuth(await createTestTempDirectory("round3-refresh-replay"));
    await runtime.warmup();
    const owner = await seedRefresh(runtime);
    const revoked: string[] = [];
    const unsubscribe = runtime.onAccessRevoked(({ grantId }) => revoked.push(grantId));
    try {
        const fields = { grant_type: "refresh_token", refresh_token: owner.token, client_id: owner.clientId };
        const first = await oidcRequest(runtime, "/token", fields);
        assert.equal(first.status, 200);
        assert.equal((await runtime.verifyAccessToken(betaResource, first.body.access_token!)).grantId, owner.grantId);
        const replay = await oidcRequest(runtime, "/token", fields);
        assert.equal(replay.status, 400);
        assert.equal(replay.body.error, "invalid_grant");
        assert.equal(revoked.includes(owner.grantId), true);
        await assert.rejects(runtime.verifyAccessToken(betaResource, first.body.access_token!), /invalid|expired/iu);
        assert.equal(await runtime.provider.RefreshToken.find(first.body.refresh_token!), undefined);
    } finally { unsubscribe(); }
});
