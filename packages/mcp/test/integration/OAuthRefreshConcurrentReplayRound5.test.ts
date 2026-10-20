import assert from "node:assert/strict";
import test from "node:test";
import { authFixture, resourceUri } from "./Round5NativeHttpFixture.ts";

// One request wins the concurrent refresh race. Replay must revoke its successor family.
test("round5 real HTTP concurrent refresh replay revokes winning token but preserves peer", async (t) => {
    const f = await authFixture(t);
    const owner = await f.issue("owner");
    const peer = await f.issue("peer");
    const fields = { grant_type: "refresh_token", client_id: owner.clientId, refresh_token: owner.refresh };
    const results = await Promise.all([f.form("/token", fields), f.form("/token", fields)]);
    assert.deepEqual(results.map(({ status }) => status).sort(), [200, 400]);
    const winner = results.find(({ status }) => status === 200)!;
    assert.equal(results.find(({ status }) => status === 400)!.body.error, "invalid_grant");
    assert.ok(winner.body.access_token);
    assert.equal((await f.raw(winner.body.access_token, "resources/list")).status, 401);
    assert.equal((await f.raw(owner.token, "resources/list")).status, 401);
    assert.equal((await f.form("/token", { ...fields, refresh_token: winner.body.refresh_token! })).status, 400);
    assert.equal((await f.raw(peer.token, "resources/read", { uri: resourceUri })).status, 200);
});
