import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { createMcpOAuthOidcAdapterFactory } from "../../../src/oauth/provider/Adapter.ts";
import { betaOAuth, betaResource, oidcRequest, seedRefresh } from "../../support/BetaOAuth.ts";

function fields(owner: { clientId: string; token: string }) {
    return { client_id: owner.clientId, grant_type: "refresh_token", refresh_token: owner.token };
}

function records(directory: string) {
    const database = new DatabaseSync(join(directory, "adapter", "oidc.sqlite3"), { readOnly: true });
    try {
        return database.prepare("SELECT model, id, payload, consumed, expires_at FROM oidc_records ORDER BY model, id").all() as Array<{
            model: string; id: string; payload: string; consumed: number | null; expires_at: number | null;
        }>;
    } finally { database.close(); }
}

test("OAuth concurrent rotation revokes all issued generations while isolating another grant of the same client", async () => {
    const directory = await createTestTempDirectory("oauth-refresh-family");
    const runtime = betaOAuth(directory);
    await runtime.warmup();
    const owner = await seedRefresh(runtime);
    const peer = await seedRefresh(runtime);
    assert.equal(owner.clientId, peer.clientId);
    assert.notEqual(owner.grantId, peer.grantId);
    const initial = await oidcRequest(runtime, "/token", fields(owner));
    assert.equal(initial.status, 200);
    const stale = await runtime.provider.RefreshToken.find(initial.body.refresh_token!);
    assert.ok(stale);
    const staleAccess = await runtime.provider.AccessToken.find(initial.body.access_token!);
    assert.ok(staleAccess);
    const staleAccessPayload = await runtime.provider.AccessToken.adapter.find(staleAccess.jti);
    assert.ok(staleAccessPayload);
    const revocationSnapshots: Array<{ grantId: string; hasTokens: boolean }> = [];
    runtime.onAccessRevoked(({ grantId }) => {
        revocationSnapshots.push({ grantId, hasTokens: records(directory).some((row) => JSON.parse(row.payload).grantId === grantId) });
    });
    const requests = { ...fields(owner), refresh_token: initial.body.refresh_token! };
    const results = await Promise.all(Array.from({ length: 8 }, () => oidcRequest(runtime, "/token", requests)));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 400, 400, 400, 400, 400, 400, 400]);
    const winner = results.find((result) => result.status === 200)!;
    assert.ok(winner.body.access_token);
    assert.ok(winner.body.refresh_token);
    for (const result of results.filter((result) => result.status === 400)) assert.equal(result.body.error, "invalid_grant");
    for (const access of [initial.body.access_token!, winner.body.access_token]) {
        await assert.rejects(runtime.verifyAccessToken(betaResource, access), /invalid|expired/iu);
    }
    assert.equal(await runtime.provider.RefreshToken.find(winner.body.refresh_token), undefined);
    assert.deepEqual(revocationSnapshots, [{ grantId: owner.grantId, hasTokens: false }]);
    await assert.rejects(stale.save(), { error: "invalid_grant" });
    await assert.rejects(runtime.provider.AccessToken.adapter.upsert(staleAccess.jti, staleAccessPayload, 3600), { error: "invalid_grant" });
    const peerResult = await oidcRequest(runtime, "/token", fields(peer));
    assert.equal(peerResult.status, 200);
    assert.equal((await runtime.verifyAccessToken(betaResource, peerResult.body.access_token!)).grantId, peer.grantId);
});

test("OAuth validates client and scopes before consumption or replay revocation and never expands scope", async () => {
    const runtime = betaOAuth(await createTestTempDirectory("oauth-refresh-validation"));
    await runtime.warmup();
    const owner = await seedRefresh(runtime);
    const peer = await seedRefresh(runtime, "peer");
    const wrongClient = { ...fields(owner), client_id: peer.clientId };
    const wrong = await oidcRequest(runtime, "/token", wrongClient);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, "invalid_grant");
    const expanded = await oidcRequest(runtime, "/token", { ...fields(owner), scope: "mcp admin" });
    assert.equal(expanded.status, 400);
    assert.equal(expanded.body.error, "invalid_scope");
    assert.equal((await runtime.provider.RefreshToken.find(owner.token))?.consumed, undefined);
    const first = await oidcRequest(runtime, "/token", { ...fields(owner), scope: "mcp" });
    assert.equal(first.status, 200);
    assert.equal(first.body.scope, "mcp");
    assert.deepEqual((await runtime.verifyAccessToken(betaResource, first.body.access_token!)).scopes, ["mcp"]);
    assert.equal((await oidcRequest(runtime, "/token", wrongClient)).body.error, "invalid_grant");
    assert.equal((await oidcRequest(runtime, "/token", { ...fields(owner), scope: "admin" })).body.error, "invalid_scope");
    assert.ok(await runtime.provider.RefreshToken.find(first.body.refresh_token!));
    assert.equal((await runtime.verifyAccessToken(betaResource, first.body.access_token!)).grantId, owner.grantId);
});

test("OAuth late issuance failures roll back consumption and successors, allowing a corrected refresh", async (t) => {
    const directory = await createTestTempDirectory("oauth-refresh-rollback");
    const runtime = betaOAuth(directory);
    await runtime.warmup();
    const owner = await seedRefresh(runtime);
    const before = records(directory);
    const invalidTarget = await oidcRequest(runtime, "/token", { ...fields(owner), resource: "http://mcp.example.test/other/mcp" });
    assert.equal(invalidTarget.status, 400);
    assert.equal(invalidTarget.body.error, "invalid_target");
    assert.deepEqual(records(directory), before);
    const save = t.mock.method(runtime.provider.AccessToken.prototype, "save", async () => { throw new Error("injected access persistence failure"); });
    const failed = await oidcRequest(runtime, "/token", fields(owner));
    assert.equal(failed.status, 500);
    assert.equal(failed.body.error, "server_error");
    assert.deepEqual(records(directory), before);
    save.mock.restore();
    const recovered = await oidcRequest(runtime, "/token", fields(owner));
    assert.equal(recovered.status, 200);
    assert.equal((await runtime.verifyAccessToken(betaResource, recovered.body.access_token!)).grantId, owner.grantId);
});

test("OAuth route aliases retain atomic refresh and replay revocation", async () => {
    const runtime = betaOAuth(await createTestTempDirectory("oauth-refresh-route-alias"));
    await runtime.warmup();
    const owner = await seedRefresh(runtime);
    const results = await Promise.all([oidcRequest(runtime, "/TOKEN/", fields(owner)), oidcRequest(runtime, "/token", fields(owner))]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
    const winner = results.find((result) => result.status === 200)!;
    await assert.rejects(runtime.verifyAccessToken(betaResource, winner.body.access_token!), /invalid|expired/iu);
});

test("OAuth PKCE code exchange still issues usable refresh credentials and their replay revokes the original access token", async () => {
    const runtime = betaOAuth(await createTestTempDirectory("oauth-refresh-pkce"));
    await runtime.warmup();
    const owner = await seedRefresh(runtime);
    const client = await runtime.provider.Client.find(owner.clientId);
    assert.ok(client);
    const verifier = "v".repeat(43);
    const code = new runtime.provider.AuthorizationCode({
        accountId: runtime.accountId, client, grantId: owner.grantId, gty: "authorization_code",
        redirectUri: "http://mcp.example.test/callback-a", resource: [betaResource.href], scope: "mcp offline_access",
        codeChallenge: createHash("sha256").update(verifier).digest("base64url"), codeChallengeMethod: "S256",
    });
    const request = { client_id: owner.clientId, grant_type: "authorization_code", code: await code.save(),
        redirect_uri: "http://mcp.example.test/callback-a", code_verifier: "x".repeat(43) };
    assert.equal((await oidcRequest(runtime, "/token", request)).status, 400);
    assert.equal((await runtime.provider.AuthorizationCode.find(request.code))?.isValid, true);
    const initial = await oidcRequest(runtime, "/token", { ...request, code_verifier: verifier });
    assert.equal(initial.status, 200);
    assert.ok(initial.body.refresh_token);
    assert.equal((await runtime.verifyAccessToken(betaResource, initial.body.access_token!)).grantId, owner.grantId);
    const refresh = { ...fields(owner), refresh_token: initial.body.refresh_token };
    const rotated = await oidcRequest(runtime, "/token", refresh);
    assert.equal(rotated.status, 200);
    const replay = await oidcRequest(runtime, "/token", refresh);
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "invalid_grant");
    await assert.rejects(runtime.verifyAccessToken(betaResource, initial.body.access_token!), /invalid|expired/iu);
    await assert.rejects(runtime.verifyAccessToken(betaResource, rotated.body.access_token!), /invalid|expired/iu);
});

test("OAuth SQLite compare-and-set consumes once, preserves consumption on upsert and fences stale writes after replay", async () => {
    const directory = await createTestTempDirectory("oauth-adapter-consume");
    const first = createMcpOAuthOidcAdapterFactory(directory);
    const second = createMcpOAuthOidcAdapterFactory(directory);
    const payload = { grantId: "owner", kind: "RefreshToken" };
    await first("RefreshToken").upsert("refresh", payload, 3600);
    await first("AccessToken").upsert("access", { grantId: "owner" }, 3600);
    await first("RefreshToken").consume("refresh");
    await first("RefreshToken").upsert("refresh", payload, 3600);
    assert.equal(typeof (await second("RefreshToken").find("refresh"))?.consumed, "number");
    await assert.rejects(second("RefreshToken").consume("refresh"), { error: "invalid_grant" });
    assert.equal(await first("AccessToken").find("access"), undefined);
    await assert.rejects(first("RefreshToken").upsert("successor", payload, 3600), { error: "invalid_grant" });
    await assert.rejects(second("AccessToken").upsert("late-access", { grantId: "owner" }, 3600), { error: "invalid_grant" });
    await assert.rejects(second("RefreshToken").consume("unknown"), { error: "invalid_grant" });

    await first("RefreshToken").upsert("race", { grantId: "peer" }, 3600);
    const results = await Promise.allSettled([first("RefreshToken").consume("race"), second("RefreshToken").consume("race")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(results.find((result) => result.status === "rejected")!.reason.error, "invalid_grant");
});

test("OAuth failed revocation transactions preserve the family and suppress uncommitted notifications", async () => {
    const directory = await createTestTempDirectory("oauth-revocation-rollback");
    const factory = createMcpOAuthOidcAdapterFactory(directory);
    const refresh = factory("RefreshToken");
    await refresh.upsert("refresh", { grantId: "owner" }, 3600);
    const notifications: string[] = [];
    await factory.transaction(async () => {
        await refresh.revokeByGrantId("owner");
        factory.afterCommit(() => notifications.push("revoked"));
    }, () => 500);
    assert.equal(notifications.length, 0);
    assert.ok(await refresh.find("refresh"));
    await factory.transaction(async () => {
        await refresh.revokeByGrantId("owner");
        factory.afterCommit(() => notifications.push("revoked"));
    }, () => 400);
    assert.deepEqual(notifications, ["revoked"]);
    assert.equal(await refresh.find("refresh"), undefined);
});

test("OAuth request transactions defer the database lock until a token lookup so pending input cannot block another refresh", { timeout: 5_000 }, async () => {
    const directory = await createTestTempDirectory("oauth-refresh-lazy-lock");
    const first = createMcpOAuthOidcAdapterFactory(directory);
    const second = createMcpOAuthOidcAdapterFactory(directory);
    await first("RefreshToken").upsert("refresh", { grantId: "owner" }, 3600);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const pendingInput = new Promise<void>((resolve) => { release = resolve; });
    const pending = first.transaction(async () => { enter(); await pendingInput; }, () => 200);
    await entered;
    await second("RefreshToken").consume("refresh");
    assert.equal(typeof (await second("RefreshToken").find("refresh"))?.consumed, "number");
    release();
    await pending;
});

test("OAuth JSON migration preserves consumed tokens and detects replay after reload without widening client scopes", async () => {
    const directory = await createTestTempDirectory("oauth-refresh-migration");
    const runtime = betaOAuth(directory);
    await runtime.warmup();
    const owner = await seedRefresh(runtime);
    const issued = await oidcRequest(runtime, "/token", fields(owner));
    assert.equal(issued.status, 200);
    const snapshot = records(directory);
    const adapterDir = join(directory, "adapter");
    const legacy: Record<string, Record<string, unknown>> = {};
    for (const row of snapshot) {
        legacy[row.model] ??= {};
        legacy[row.model]![row.id] = { payload: JSON.parse(row.payload), expiresAt: row.expires_at ?? undefined, consumed: row.consumed ?? undefined };
    }
    await rm(join(adapterDir, "oidc.sqlite3"));
    for (const [model, state] of Object.entries(legacy)) await writeFile(join(adapterDir, `${model}.json`), JSON.stringify(state));
    const reloaded = betaOAuth(directory);
    await reloaded.warmup();
    assert.deepEqual(records(directory), snapshot);
    assert.deepEqual((await readdir(adapterDir)).sort(), [...Object.keys(legacy).map((model) => `${model}.json`), "oidc.sqlite3"].sort());
    for (const [model, state] of Object.entries(legacy)) {
        assert.equal(await readFile(join(adapterDir, `${model}.json`), "utf8"), JSON.stringify(state));
    }
    assert.equal((await reloaded.provider.Client.find(owner.clientId))?.scope, "openid offline_access mcp");
    assert.equal((await reloaded.verifyAccessToken(betaResource, issued.body.access_token!)).grantId, owner.grantId);
    const replay = await oidcRequest(reloaded, "/token", fields(owner));
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "invalid_grant");
    await assert.rejects(reloaded.verifyAccessToken(betaResource, issued.body.access_token!), /invalid|expired/iu);
    const reopened = betaOAuth(directory);
    await reopened.warmup();
    assert.equal(await reopened.provider.RefreshToken.find(issued.body.refresh_token!), undefined);
});

test("OAuth migration isolates malformed model data and retries that model after repair without deleting sources", async () => {
    const directory = await createTestTempDirectory("oauth-migration-rollback");
    await mkdir(directory, { recursive: true });
    const clients = JSON.stringify({ client: { payload: { client_id: "client", scope: "openid" } } });
    await writeFile(join(directory, "Client.json"), clients);
    await writeFile(join(directory, "RefreshToken.json"), "{broken");
    const first = createMcpOAuthOidcAdapterFactory(directory);
    await first.prepare();
    assert.equal((await first("Client").find("client"))?.scope, "openid");
    await assert.rejects(first("RefreshToken").find("refresh"), { code: "OIDC_MODEL_MIGRATION", model: "RefreshToken" });
    assert.equal(await readFile(join(directory, "Client.json"), "utf8"), clients);
    assert.equal(await readFile(join(directory, "RefreshToken.json"), "utf8"), "{broken");
    await writeFile(join(directory, "RefreshToken.json"), "{}");
    const reopened = createMcpOAuthOidcAdapterFactory(directory);
    assert.equal(await reopened("RefreshToken").find("refresh"), undefined);
    assert.equal((await reopened("Client").find("client"))?.scope, "openid");
});
