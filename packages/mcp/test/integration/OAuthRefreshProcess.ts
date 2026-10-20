// Isolated local test runtime; never starts or restarts a product Worker.
import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { betaOAuth, betaResource, oidcRequest } from "../support/BetaOAuth.ts";

export interface OAuthRefreshWorkerInput {
    directory: string;
    phase: "refresh" | "verify";
    clientId: string;
    refresh: string;
    revokedAccess?: string[];
    peerAccess?: string;
    peerGrant?: string;
}

const input = workerData as OAuthRefreshWorkerInput;
assert.ok(parentPort);
const runtime = betaOAuth(input.directory);
await runtime.warmup();
parentPort.postMessage({ ready: true });
await new Promise<void>((resolve) => parentPort!.once("message", () => resolve()));
if (input.phase === "refresh") {
    parentPort.postMessage(await oidcRequest(runtime, "/token", {
        client_id: input.clientId, grant_type: "refresh_token", refresh_token: input.refresh,
    }));
} else {
    assert.ok(input.revokedAccess);
    assert.ok(input.peerAccess);
    assert.ok(input.peerGrant);
    for (const access of input.revokedAccess) await assert.rejects(runtime.verifyAccessToken(betaResource, access), /invalid|expired/iu);
    const rejected = await oidcRequest(runtime, "/token", {
        client_id: input.clientId, grant_type: "refresh_token", refresh_token: input.refresh,
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, "invalid_grant");
    assert.equal((await runtime.verifyAccessToken(betaResource, input.peerAccess)).grantId, input.peerGrant);
    parentPort.postMessage({ status: 400, body: { error: "invalid_grant" } });
}
parentPort.close();
