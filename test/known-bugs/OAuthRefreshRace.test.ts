import assert from "node:assert/strict";
import test from "node:test";
import { createTestTempDirectory } from "../TestTempDirectory.ts";
import { betaOAuth, betaResource, oidcRequest, seedRefresh } from "../../packages/mcp/test/support/BetaOAuth.ts";

test("one public-client refresh token must not mint two valid successor branches", async () => {
    const runtime = betaOAuth(await createTestTempDirectory("round3-refresh-race"));
    await runtime.warmup();
    const owner = await seedRefresh(runtime);
    const results = await Promise.all(Array.from({ length: 2 }, () => oidcRequest(runtime, "/token", {
        client_id: owner.clientId, grant_type: "refresh_token", refresh_token: owner.token,
    })));
    const statuses = results.map((result) => result.status);
    const accessValid = await Promise.all(results.map(async (result) => {
        const verified = await runtime.verifyAccessToken(betaResource, result.body.access_token!);
        return verified.clientId === owner.clientId && verified.grantId === owner.grantId;
    }));
    const refreshValid = await Promise.all(results.map(async (result) => Boolean(await runtime.provider.RefreshToken.find(result.body.refresh_token!))));
    console.log(JSON.stringify({ statuses, distinctSuccessors: results[0]!.body.refresh_token !== results[1]!.body.refresh_token, accessValid, refreshValid }));
    assert.equal(statuses.filter((status) => status === 200).length, 1);
});
