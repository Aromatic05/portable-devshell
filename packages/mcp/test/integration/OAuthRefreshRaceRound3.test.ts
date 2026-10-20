import assert from "node:assert/strict";
import test from "node:test";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { betaOAuth, betaResource, oidcRequest, seedRefresh } from "../support/BetaOAuth.ts";

test("one public-client refresh token must not mint two valid successor branches", async () => {
    const runtime = betaOAuth(await createTestTempDirectory("round3-refresh-race"));
    await runtime.warmup();
    const owner = await seedRefresh(runtime);
    const results = await Promise.all(Array.from({ length: 2 }, () => oidcRequest(runtime, "/token", {
        client_id: owner.clientId, grant_type: "refresh_token", refresh_token: owner.token,
    })));
    const statuses = results.map((result) => result.status);
    assert.equal(statuses.filter((status) => status === 200).length, 1);
    assert.deepEqual(statuses.sort(), [200, 400]);
    const winner = results.find((result) => result.status === 200)!;
    const loser = results.find((result) => result.status === 400)!;
    assert.equal(loser.body.error, "invalid_grant");
    assert.ok(winner.body.access_token);
    assert.ok(winner.body.refresh_token);
    await assert.rejects(runtime.verifyAccessToken(betaResource, winner.body.access_token), /invalid|expired/iu);
    assert.equal(await runtime.provider.RefreshToken.find(winner.body.refresh_token), undefined);
    assert.equal(await runtime.provider.Grant.find(owner.grantId), undefined);
});
