import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { createMcpOAuthOidcAdapterFactory } from "../../src/oauth/provider/Adapter.ts";
import { betaOAuth, betaResource, oidcRequest, seedRefresh } from "../support/BetaOAuth.ts";

type Row = { model: string; id: string; payload: string; consumed: number | null; expires_at: number | null };
function rows(directory: string): Row[] {
    const database = new DatabaseSync(join(directory, "adapter", "oidc.sqlite3"));
    try { return database.prepare("SELECT model, id, payload, consumed, expires_at FROM oidc_records ORDER BY model, id").all() as Row[]; }
    finally { database.close(); }
}

async function oldGeneration(directory: string) {
    const runtime = betaOAuth(directory);
    await runtime.warmup();
    const owner = await seedRefresh(runtime);
    const peer = await seedRefresh(runtime);
    const issue = async (source: typeof owner) => {
        const result = await oidcRequest(runtime, "/token", { client_id: source.clientId, grant_type: "refresh_token", refresh_token: source.token });
        assert.equal(result.status, 200);
        assert.ok(result.body.access_token);
        assert.ok(result.body.refresh_token);
        return result.body;
    };
    const initial = await issue(owner);
    const peerTokens = await issue(peer);
    const secretClient = { client_id: "installed-confidential-client", client_secret: "fixture-secret-kept-verbatim",
        client_secret_expires_at: 0, grant_types: ["authorization_code", "refresh_token"] as const, response_types: ["code"] as const,
        redirect_uris: ["https://installed.example.test/callback"], scope: "openid offline_access mcp", token_endpoint_auth_method: "client_secret_post" as const };
    const adapterDir = join(directory, "adapter");
    await createMcpOAuthOidcAdapterFactory(adapterDir)("Client").upsert(secretClient.client_id, secretClient);
    const now = Math.floor(Date.now() / 1000);
    await runtime.provider.AccessToken.adapter.upsert("expired-before-upgrade", { jti: "expired-before-upgrade", kind: "AccessToken",
        accountId: runtime.accountId, clientId: owner.clientId, grantId: owner.grantId, aud: betaResource.href, scope: "mcp", iat: now - 100, exp: now - 1 }, 3600);
    const snapshot = rows(directory);
    const sources = new Map<string, string>();
    for (const model of new Set(snapshot.map((row) => row.model))) {
        const records = Object.fromEntries(snapshot.filter((row) => row.model === model).map((row) => [row.id, {
            payload: JSON.parse(row.payload), consumed: row.consumed ?? undefined, expiresAt: row.expires_at ?? undefined,
        }]));
        sources.set(model, JSON.stringify(records));
    }
    const jwks = await readFile(join(directory, "jwks.json"), "utf8");
    await rm(join(adapterDir, "oidc.sqlite3"));
    for (const [model, source] of sources) await writeFile(join(adapterDir, `${model}.json`), source, { mode: 0o600 });
    return { directory, adapterDir, snapshot, sources, jwks, owner, peer, initial, peerTokens, secretClient };
}

async function assertSources(fixture: Awaited<ReturnType<typeof oldGeneration>>) {
    for (const [model, source] of fixture.sources) assert.equal(await readFile(join(fixture.adapterDir, `${model}.json`), "utf8"), source);
    assert.equal(await readFile(join(fixture.directory, "jwks.json"), "utf8"), fixture.jwks);
}

async function child(t: TestContext, directory: string, phase: string) {
    const process = spawn(globalThis.process.execPath, ["--import", "tsx", fileURLToPath(new URL("./OAuthMigrationProcess.ts", import.meta.url)), directory, phase], {
        env: globalThis.process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => { process.kill("SIGKILL"); });
    const output = createInterface({ input: process.stdout });
    const exited = once(process, "exit");
    const ready = await Promise.race([
        once(output, "line").then(([line]) => JSON.parse(line as string) as { checkpoint: string }),
        exited.then(([code, signal]) => assert.fail(`migration child exited before checkpoint: ${code}/${signal}`)),
    ]);
    output.close();
    assert.equal(ready.checkpoint, phase);
    return { process, exited };
}

test("OAuth opens installed JSON state automatically without changing credentials, expiry, grants, scopes or signing keys", async () => {
    const f = await oldGeneration(await createTestTempDirectory("oauth-auto-installed"));
    await writeFile(join(f.adapterDir, "unrelated.json"), "{unrelated invalid JSON");
    await writeFile(join(f.adapterDir, "Client.json.interrupted.tmp"), "{unfinished");
    const runtime = betaOAuth(f.directory);
    await runtime.warmup();
    assert.deepEqual(rows(f.directory), f.snapshot);
    await assertSources(f);
    assert.deepEqual(await createMcpOAuthOidcAdapterFactory(f.adapterDir)("Client").find(f.secretClient.client_id), f.secretClient);
    assert.equal((await runtime.verifyAccessToken(betaResource, f.initial.access_token!)).grantId, f.owner.grantId);
    assert.equal((await runtime.verifyAccessToken(betaResource, f.peerTokens.access_token!)).grantId, f.peer.grantId);
    await assert.rejects(runtime.verifyAccessToken(betaResource, "expired-before-upgrade"), /invalid|expired/iu);
    const fields = { client_id: f.owner.clientId, grant_type: "refresh_token", refresh_token: f.initial.refresh_token! };
    const renewed = await oidcRequest(runtime, "/token", fields);
    assert.equal(renewed.status, 200);
    const replay = await oidcRequest(runtime, "/token", { ...fields, refresh_token: f.owner.token });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "invalid_grant");
    const reopened = betaOAuth(f.directory);
    await reopened.warmup();
    await assert.rejects(reopened.verifyAccessToken(betaResource, f.initial.access_token!), /invalid|expired/iu);
    await assert.rejects(reopened.verifyAccessToken(betaResource, renewed.body.access_token!), /invalid|expired/iu);
    assert.equal((await reopened.verifyAccessToken(betaResource, f.peerTokens.access_token!)).grantId, f.peer.grantId);
    assert.equal(await reopened.provider.RefreshToken.find(renewed.body.refresh_token!), undefined);
    assert.equal(await readFile(join(f.adapterDir, "unrelated.json"), "utf8"), "{unrelated invalid JSON");
    await assertSources(f);
});

for (const phase of ["partial", "committed"]) {
    test(`OAuth automatic migration recovers after SIGKILL at ${phase} import without reissuing or losing prior state`, {
        timeout: 30_000, skip: process.platform === "win32" ? "requires POSIX SIGKILL evidence" : false,
    }, async (t) => {
        const f = await oldGeneration(await createTestTempDirectory(`oauth-auto-kill-${phase}`));
        const importer = await child(t, f.directory, phase);
        assert.equal(importer.process.kill("SIGKILL"), true);
        const [code, signal] = await importer.exited;
        assert.equal(code, null);
        assert.equal(signal, "SIGKILL");
        await assertSources(f);
        assert.equal(rows(f.directory).length, phase === "partial" ? 0 : f.snapshot.length);
        const runtime = betaOAuth(f.directory);
        await runtime.warmup();
        assert.deepEqual(rows(f.directory), f.snapshot);
        assert.equal((await runtime.verifyAccessToken(betaResource, f.initial.access_token!)).grantId, f.owner.grantId);
        const refreshed = await oidcRequest(runtime, "/token", { client_id: f.owner.clientId, grant_type: "refresh_token", refresh_token: f.initial.refresh_token! });
        assert.equal(refreshed.status, 200);
        await assertSources(f);
    });
}

test("OAuth simultaneous opens import the installed generation once across independent processes", { timeout: 30_000 }, async (t) => {
    const f = await oldGeneration(await createTestTempDirectory("oauth-auto-concurrent-open"));
    const importers = await Promise.all(Array.from({ length: 4 }, () => child(t, f.directory, "open")));
    for (const importer of importers) assert.deepEqual(await importer.exited, [0, null]);
    assert.deepEqual(rows(f.directory), f.snapshot);
    await assertSources(f);
});

test("OAuth unsafe legacy model input is scoped and unrelated symlinks are ignored without traversing their target", async () => {
    const directory = await createTestTempDirectory("oauth-auto-symlink");
    const outside = await createTestTempDirectory("oauth-auto-outside");
    const target = join(outside, "tokens.json");
    const source = JSON.stringify({ outside: { payload: { grantId: "outside-grant" } } });
    await writeFile(target, source, { mode: 0o600 });
    await symlink(target, join(directory, "RefreshToken.json"));
    await symlink(target, join(directory, "unrelated.json"));
    await writeFile(join(directory, "Client.json"), JSON.stringify({ client: { payload: { client_id: "client", scope: "openid" } } }));
    const factory = createMcpOAuthOidcAdapterFactory(directory);
    await factory.prepare();
    assert.equal((await factory("Client").find("client"))?.scope, "openid");
    await assert.rejects(factory("RefreshToken").find("outside"), { code: "OIDC_MODEL_MIGRATION", model: "RefreshToken" });
    assert.equal((await lstat(join(directory, "RefreshToken.json"))).isSymbolicLink(), true);
    assert.equal(await readFile(target, "utf8"), source);
    assert.deepEqual(await readdir(outside), ["tokens.json"]);
});

test("OAuth refuses a symlinked database, journal or adapter directory without changing the external target", async () => {
    const outside = await createTestTempDirectory("oauth-auto-database-outside");
    const target = join(outside, "external");
    await writeFile(target, "outside-data", { mode: 0o600 });
    for (const name of ["oidc.sqlite3", "oidc.sqlite3-journal", "oidc.sqlite3-wal", "oidc.sqlite3-shm"]) {
        const directory = await createTestTempDirectory("oauth-auto-database-link");
        await symlink(target, join(directory, name));
        await assert.rejects(createMcpOAuthOidcAdapterFactory(directory).prepare(), /symbolic link/u);
        assert.equal(await readFile(target, "utf8"), "outside-data");
    }
    const parent = await createTestTempDirectory("oauth-auto-directory-link");
    await symlink(outside, join(parent, "adapter"), "dir");
    await assert.rejects(createMcpOAuthOidcAdapterFactory(join(parent, "adapter")).prepare(), /symbolic link/u);
    assert.deepEqual(await readdir(outside), ["external"]);
});

test("OAuth rejects malformed identities and scopes per model without importing a partial model or exposing secrets", async () => {
    const directory = await createTestTempDirectory("oauth-auto-corrupt-model");
    await mkdir(directory, { recursive: true });
    const valid = { good: { payload: { grantId: "peer", scope: "mcp" } } };
    const unsafe = { ...valid, "fixture-secret-identifier": { payload: { grantId: { unsafe: true }, scope: "fixture-secret-scope" } } };
    await writeFile(join(directory, "AccessToken.json"), JSON.stringify(unsafe));
    await writeFile(join(directory, "RefreshToken.json"), JSON.stringify({ refresh: { payload: { grantId: "peer", scope: "mcp" } } }));
    const factory = createMcpOAuthOidcAdapterFactory(directory);
    await factory.prepare();
    assert.ok(await factory("RefreshToken").find("refresh"));
    await assert.rejects(factory("AccessToken").find("good"), { code: "OIDC_MODEL_MIGRATION", model: "AccessToken",
        message: "OIDC AccessToken.json migration: invalid record metadata or identity; source was preserved." });
    const db = new DatabaseSync(join(directory, "oidc.sqlite3"));
    assert.equal(db.prepare("SELECT count(*) AS count FROM oidc_records WHERE model = 'AccessToken'").get()?.count, 0);
    db.close();
    await factory("RefreshToken").revokeByGrantId("peer");
    await writeFile(join(directory, "AccessToken.json"), JSON.stringify(valid));
    const repaired = createMcpOAuthOidcAdapterFactory(directory);
    assert.equal(await repaired("AccessToken").find("good"), undefined);
    assert.equal(await repaired("RefreshToken").find("refresh"), undefined);
});
