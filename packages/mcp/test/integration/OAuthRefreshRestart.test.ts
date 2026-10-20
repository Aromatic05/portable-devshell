import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { betaOAuth, betaResource, oidcRequest, seedRefresh } from "../support/BetaOAuth.ts";
import { Round4MemoryHttp } from "./AuthTransportRound4MemoryHttp.ts";
import type { OAuthRefreshWorkerInput } from "./OAuthRefreshProcess.ts";

interface TokenResult { status: number; body: Record<string, string>; }

async function prepareWorker(input: OAuthRefreshWorkerInput) {
    const worker = new Worker(new URL("./OAuthRefreshProcess.ts", import.meta.url), {
        execArgv: ["--import", "tsx"], workerData: input,
    });
    const exited = once(worker, "exit");
    const [ready] = await once(worker, "message");
    assert.deepEqual(ready, { ready: true });
    return async (): Promise<TokenResult> => {
        const result = once(worker, "message");
        worker.postMessage("start");
        const [value] = await result;
        const [code] = await exited;
        assert.equal(code, 0);
        return value as TokenResult;
    };
}

async function issue(runtime: ReturnType<typeof betaOAuth>, owner: Awaited<ReturnType<typeof seedRefresh>>) {
    const response = await oidcRequest(runtime, "/token", {
        client_id: owner.clientId, grant_type: "refresh_token", refresh_token: owner.token,
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.access_token);
    assert.ok(response.body.refresh_token);
    return response;
}

test("OAuth concurrent fresh isolates share atomic single-use rotation and durable revocation with an existing resource verifier", { timeout: 30_000 }, async (t) => {
    const directory = await createTestTempDirectory("oauth-refresh-isolate-race");
    const runtime = betaOAuth(directory);
    await runtime.warmup();
    const owner = await seedRefresh(runtime);
    const peer = await seedRefresh(runtime);
    const initial = await issue(runtime, owner);
    const peerTokens = await issue(runtime, peer);
    const input: OAuthRefreshWorkerInput = { directory, phase: "refresh", clientId: owner.clientId, refresh: initial.body.refresh_token! };
    const workers = await Promise.all(Array.from({ length: 4 }, () => prepareWorker(input)));
    const results = await Promise.all(workers.map((start) => start()));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 400, 400, 400]);
    const winner = results.find((result) => result.status === 200)!;
    assert.ok(winner.body.access_token);
    assert.ok(winner.body.refresh_token);
    for (const result of results.filter((result) => result.status === 400)) assert.equal(result.body.error, "invalid_grant");

    // Actual Express bearer middleware and resource verifier over Node HTTP
    // messages, explicitly without a TCP listener or simulated auth decisions.
    const http = new Round4MemoryHttp();
    http.app.post("/demo/mcp", runtime.requestAuthHandler(betaResource), (_request, response) => response.json({ ok: true }));
    const resourceStatus = async (access: string) => {
        const response = await http.fetch(betaResource, { method: "POST", headers: { authorization: `Bearer ${access}` } });
        await response.text();
        return response.status;
    };
    assert.equal(await resourceStatus(initial.body.access_token!), 401);
    assert.equal(await resourceStatus(winner.body.access_token), 401);
    assert.equal(await resourceStatus(peerTokens.body.access_token!), 200);
    const verify = await prepareWorker({ ...input, phase: "verify", refresh: winner.body.refresh_token,
        revokedAccess: [initial.body.access_token!, winner.body.access_token], peerAccess: peerTokens.body.access_token!, peerGrant: peer.grantId });
    assert.equal((await verify()).status, 400);
    t.diagnostic("four fresh Worker-thread isolates plus a fifth restart verifier; real SQLite/OIDC/Express, no product Worker restart or TCP claim");
});

test("OAuth replay after a completed isolated-runtime restart revokes the latest successor and all earlier access tokens", { timeout: 30_000 }, async () => {
    const directory = await createTestTempDirectory("oauth-refresh-isolate-restart");
    const runtime = betaOAuth(directory);
    await runtime.warmup();
    const owner = await seedRefresh(runtime);
    const peer = await seedRefresh(runtime, "peer");
    const peerTokens = await issue(runtime, peer);
    const input: OAuthRefreshWorkerInput = { directory, phase: "refresh", clientId: owner.clientId, refresh: owner.token };
    const first = await (await prepareWorker(input))();
    assert.equal(first.status, 200);
    assert.equal((await runtime.verifyAccessToken(betaResource, first.body.access_token!)).grantId, owner.grantId);
    const second = await (await prepareWorker({ ...input, refresh: first.body.refresh_token! }))();
    assert.equal(second.status, 200);
    const replay = await (await prepareWorker(input))();
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "invalid_grant");
    const verify = await prepareWorker({ ...input, phase: "verify", refresh: second.body.refresh_token!,
        revokedAccess: [first.body.access_token!, second.body.access_token!], peerAccess: peerTokens.body.access_token!, peerGrant: peer.grantId });
    assert.equal((await verify()).status, 400);
    await assert.rejects(runtime.verifyAccessToken(betaResource, second.body.access_token!), /invalid|expired/iu);
});
