import assert from "node:assert/strict";
import test from "node:test";
import { authFixture, resourceUri } from "./AuthTransportRound4Support.ts";

// This fixture supports an explicitly selected memory HTTP transport. It uses
// the same OIDC, bearer verifier, MCP ingress, Context and SQLite audit layers.
// The original Round5 TCP-only reproduction remains unchanged.
test("OAuth concurrent refresh replay rejects old and winning credentials at MCP ingress while preserving a peer", async (t) => {
    const f = await authFixture(t);
    const owner = await f.issue("owner");
    const peer = await f.issue("peer");
    const connected = await f.connect(owner.token);
    assert.equal((await connected.listResources()).resources.length, 1);
    const fields = { grant_type: "refresh_token", client_id: owner.clientId, refresh_token: owner.refresh };
    const results = await Promise.all([f.form("/token", fields), f.form("/token", fields)]);
    assert.deepEqual(results.map(({ status }) => status).sort(), [200, 400]);
    assert.equal(results.find(({ status }) => status === 400)!.body.error, "invalid_grant");
    const winner = results.find(({ status }) => status === 200)!;
    assert.ok(winner.body.access_token);
    assert.ok(winner.body.refresh_token);
    assert.equal((await f.raw(winner.body.access_token, "resources/list")).status, 401);
    assert.equal((await f.raw(owner.token, "resources/list")).status, 401);
    await assert.rejects(connected.listResources(), { status: 401 });
    assert.equal((await f.form("/token", { ...fields, refresh_token: winner.body.refresh_token })).status, 400);
    assert.equal((await f.raw(peer.token, "resources/read", { uri: resourceUri })).status, 200);
    assert.equal(f.resourceReads(), 1);
});
